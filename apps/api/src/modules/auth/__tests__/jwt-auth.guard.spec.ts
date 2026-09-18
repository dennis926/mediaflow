import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { AuthSessionService, AuthSessionSnapshot } from '../auth-session.service';

const ACTIVE_SESSION: AuthSessionSnapshot = { active: true, member: true, roles: ['owner'], exists: true };

interface SessionMocks {
  resolve: ReturnType<typeof vi.fn>;
  recordRoleDrift: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
}

function buildGuard(options: {
  secret?: string;
  session?: AuthSessionSnapshot | null;
  authEnforced?: string;
  isPublic?: boolean;
} = {}): { guard: JwtAuthGuard; jwt: JwtService; sessions: SessionMocks } {
  const jwt = new JwtService({ secret: options.secret ?? 'test-secret' });
  const reflector = { getAllAndOverride: vi.fn(() => options.isPublic ?? false) } as unknown as Reflector;
  const config = { get: vi.fn((key: string) => (key === 'AUTH_ENFORCED' ? options.authEnforced : undefined)) } as unknown as ConfigService;
  const sessions = {
    resolve: vi.fn(async () => (options.session === undefined ? ACTIVE_SESSION : options.session)),
    recordRoleDrift: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => 1),
  } as unknown as AuthSessionService;
  return { guard: new JwtAuthGuard(jwt, reflector, config, sessions as unknown as AuthSessionService), jwt, sessions: sessions as unknown as SessionMocks };
}

interface GuardRequest {
  headers: Record<string, string>;
  user?: unknown;
}

function contextWithToken(token: string | null): { context: never; request: GuardRequest } {
  const request: GuardRequest = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { context: context as never, request };
}

function tokenOf(jwt: JwtService, payload: Record<string, unknown>): string {
  return jwt.sign({
    sub: 'u1', email: 'a@b.c', displayName: 'A', tenantId: 't', workspaceId: 'w',
    roles: ['owner'], isSuperAdmin: false, ...payload,
  });
}

describe('JwtAuthGuard 令牌校验（原有行为保持）', () => {
  it('接受正常访问令牌', async () => {
    const { guard, jwt } = buildGuard();
    const { context, request } = contextWithToken(tokenOf(jwt, {}));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect((request.user as { workspaceId: string }).workspaceId).toBe('w');
  });

  it('拒绝刷新令牌（否则会退化成无角色身份）', async () => {
    const { guard, jwt } = buildGuard();
    await expect(guard.canActivate(contextWithToken(jwt.sign({ sub: 'u1', type: 'refresh' })).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('拒绝缺少工作区或角色的令牌', async () => {
    const { guard, jwt } = buildGuard();
    await expect(guard.canActivate(contextWithToken(jwt.sign({ sub: 'u1', roles: ['owner'] })).context)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(contextWithToken(jwt.sign({ sub: 'u1', workspaceId: 'w' })).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('拒绝伪造/过期令牌', async () => {
    const { guard } = buildGuard();
    const forged = new JwtService({ secret: 'another-secret' }).sign({ sub: 'u1', workspaceId: 'w', roles: ['owner'] });
    await expect(guard.canActivate(contextWithToken(forged).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('无令牌时拒绝访问受保护接口', async () => {
    const { guard } = buildGuard();
    await expect(guard.canActivate(contextWithToken(null).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('JwtAuthGuard 权限即时生效（任务 2 / 审计 P1-2）', () => {
  it('账号被停用：未过期令牌立即 401', async () => {
    const { guard, jwt } = buildGuard({ session: { ...ACTIVE_SESSION, active: false } });
    await expect(guard.canActivate(contextWithToken(tokenOf(jwt, {})).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('被移出工作区：未过期令牌立即 404', async () => {
    const { guard, jwt } = buildGuard({ session: { ...ACTIVE_SESSION, member: false } });
    await expect(guard.canActivate(contextWithToken(tokenOf(jwt, {})).context)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('用户已被删除：令牌立即 401', async () => {
    const { guard, jwt } = buildGuard({ session: null });
    await expect(guard.canActivate(contextWithToken(tokenOf(jwt, {})).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('角色被降级：以数据库角色为准，且记录 auth.role_drift', async () => {
    const { guard, jwt, sessions } = buildGuard({ session: { ...ACTIVE_SESSION, roles: ['viewer'] } });
    const { context, request } = contextWithToken(tokenOf(jwt, { roles: ['admin'] }));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect((request.user as { roles: string[] }).roles).toEqual(['viewer']);
    expect(sessions.recordRoleDrift).toHaveBeenCalledTimes(1);
    expect(sessions.recordRoleDrift.mock.calls[0][3]).toEqual(['admin']); // 令牌里的旧角色
    expect(sessions.recordRoleDrift.mock.calls[0][4]).toEqual(['viewer']); // 数据库的权威角色
  });

  it('角色未被改动时不记漂移，身份沿用令牌', async () => {
    const { guard, jwt, sessions } = buildGuard({ session: { ...ACTIVE_SESSION, roles: ['admin'] } });
    const { context, request } = contextWithToken(tokenOf(jwt, { roles: ['admin'] }));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect((request.user as { roles: string[] }).roles).toEqual(['admin']);
    expect(sessions.recordRoleDrift).not.toHaveBeenCalled();
  });

  it('每次请求都会查询会话快照（缓存由 AuthSessionService 负责，TTL 30 秒）', async () => {
    const { guard, jwt, sessions } = buildGuard();
    await guard.canActivate(contextWithToken(tokenOf(jwt, {})).context);
    expect(sessions.resolve).toHaveBeenCalledWith('u1', 'w');
  });

  it('AUTH_ENFORCED=false 的本地逃生逻辑保留（无令牌可访问）', async () => {
    const { guard } = buildGuard({ authEnforced: 'false' });
    await expect(guard.canActivate(contextWithToken(null).context)).resolves.toBe(true);
  });

  it('生产配置（AUTH_ENFORCED 缺失或 true）仍然要求令牌', async () => {
    const { guard } = buildGuard({ authEnforced: 'true' });
    await expect(guard.canActivate(contextWithToken(null).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
