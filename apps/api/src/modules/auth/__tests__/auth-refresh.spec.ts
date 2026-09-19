import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { AuditService } from '../../../audit/audit.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import { User } from '../../workspace/entities/user.entity';
import { AuthSessionService } from '../auth-session.service';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { AuthService } from '../auth.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function build(options: { blocked?: boolean; status?: string; workspaceId?: string; noWorkspace?: boolean } = {}) {
  const jwt = new JwtService({ secret: 'test-secret' });
  const users = {
    findOne: vi.fn(async () => ({
      id: USER_ID,
      email: 'a@b.c',
      displayName: 'A',
      tenantId: '22222222-2222-4222-8222-222222222222',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      status: options.status ?? 'active',
      isSuperAdmin: false,
      mustChangePassword: false,
      roles: [{ code: 'owner' }],
    })),
    createQueryBuilder: vi.fn(() => ({
      leftJoin: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      getRawMany: vi.fn(async () => [{ code: 'owner' }]),
    })),
    update: vi.fn(async () => ({ affected: 1 })),
  } as unknown as Repository<User>;
  const redis = {
    get: vi.fn(async () => (options.blocked ? '1' : null)),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    multi: vi.fn(() => ({ incr: vi.fn().mockReturnThis(), expire: vi.fn().mockReturnThis(), exec: vi.fn(async () => []) })),
  };
  const auditRecord = vi.fn(async (_input: unknown) => undefined);
  const audit = { record: auditRecord } as unknown as AuditService;
  const sessions = { invalidate: vi.fn(async () => 1) } as unknown as AuthSessionService;
  // B0.4/M8：登录/刷新进入哪个工作区由成员关系解析（users.workspace_id 可能为空）
  const resolveLoginWorkspace = vi.fn(async () =>
    options.noWorkspace
      ? null
      : { workspace: { id: options.workspaceId ?? 'w-1', tenantId: 't-1', status: 'active' }, roleCodes: ['owner'] },
  );
  const workspaces = { membership: vi.fn(), resolveLoginWorkspace } as unknown as WorkspaceService;
  // 失败登录审计会读工作区作用域，这里给一个桩
  const workspaceContext = { current: async () => ({ tenantId: 't1', workspaceId: 'w1' }) } as unknown as WorkspaceContextService;
  const service = new AuthService(users, jwt, audit, redis as unknown as Redis, workspaces, sessions, workspaceContext);
  return { service, jwt, redis, auditRecord, users, resolveLoginWorkspace };
}

describe('刷新令牌轮换与登出（任务 6 / 审计 P2-5）', () => {
  it('刷新会签发新的访问令牌与刷新令牌，并把旧刷新令牌加入黑名单', async () => {
    const { service, jwt, redis } = build();
    const oldRefresh = jwt.sign({ sub: USER_ID, type: 'refresh' }, { jwtid: 'old-jti', expiresIn: '7d' });

    const result = await service.refresh(oldRefresh);

    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).not.toBe(oldRefresh);
    const newPayload = jwt.verify<{ jti?: string }>(result.refreshToken);
    expect(newPayload.jti).toBeTruthy();
    expect(redis.set).toHaveBeenCalledWith('auth:refresh:block:old-jti', '1', 'EX', expect.any(Number));
  });

  it('旧刷新令牌被再次使用 → 401（重放检测）', async () => {
    const { service, jwt } = build({ blocked: true });
    const reuse = jwt.sign({ sub: USER_ID, type: 'refresh' }, { jwtid: 'used-jti', expiresIn: '7d' });

    await expect(service.refresh(reuse)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.refresh(reuse)).rejects.toThrow(/已登出或被轮换/);
  });

  it('登出把刷新令牌加入黑名单并写审计 auth.logout', async () => {
    const { service, jwt, redis, auditRecord } = build();
    const refresh = jwt.sign({ sub: USER_ID, type: 'refresh' }, { jwtid: 'logout-jti', expiresIn: '7d' });

    await expect(service.logout(refresh, { ip: '127.0.0.1', userAgent: 'vitest' })).resolves.toEqual({ ok: true });

    expect(redis.set).toHaveBeenCalledWith('auth:refresh:block:logout-jti', '1', 'EX', expect.any(Number));
    const entry = auditRecord.mock.calls[0][0] as unknown as { action: string; resourceId: string; ip: string };
    expect(entry.action).toBe('auth.logout');
    expect(entry.resourceId).toBe(USER_ID);
    expect(entry.ip).toBe('127.0.0.1');
  });

  it('登出幂等：不带令牌或令牌非法都返回成功', async () => {
    const { service, redis } = build();
    await expect(service.logout(undefined)).resolves.toEqual({ ok: true });
    await expect(service.logout('not-a-token')).resolves.toEqual({ ok: true });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('登出后该刷新令牌无法再刷新（黑名单生效）', async () => {
    const blockedState = build({ blocked: true });
    const refresh = blockedState.jwt.sign({ sub: USER_ID, type: 'refresh' }, { jwtid: 'after-logout', expiresIn: '7d' });
    await expect(blockedState.service.refresh(refresh)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('过期但结构合法的令牌也能登出（幂等清理）', async () => {
    const { service, redis } = build();
    const expired = build().jwt.sign({ sub: USER_ID, type: 'refresh' }, { jwtid: 'expired-jti', expiresIn: -10 });
    await expect(service.logout(expired)).resolves.toEqual({ ok: true });
    expect(redis.set).toHaveBeenCalledWith('auth:refresh:block:expired-jti', '1', 'EX', 1);
  });

  it('账号被停用时不能刷新（既有行为保持）', async () => {
    const { service, jwt } = build({ status: 'disabled' });
    const refresh = jwt.sign({ sub: USER_ID, type: 'refresh' }, { jwtid: 'x', expiresIn: '7d' });
    await expect(service.refresh(refresh)).rejects.toThrow(/已被禁用/);
  });

  it('刷新令牌不能当作访问令牌使用（类型校验保持）', async () => {
    const { service, jwt } = build();
    const access = jwt.sign({ sub: USER_ID, workspaceId: 'w', roles: ['owner'] });
    await expect(service.refresh(access)).rejects.toThrow(/令牌类型不正确/);
  });
});

describe('刷新时的工作区归属（B0.4 / M8）', () => {
  it('刷新保留令牌里的工作区（不再把用户切回默认工作区）', async () => {
    const { service, jwt, resolveLoginWorkspace } = build({ workspaceId: 'w-current' });
    const refresh = jwt.sign({ sub: USER_ID, type: 'refresh', workspaceId: 'w-current' }, { jwtid: 'jti-1', expiresIn: '7d' });

    const tokens = await service.refresh(refresh);
    const payload = jwt.decode(tokens.accessToken) as { workspaceId: string };

    expect(payload.workspaceId).toBe('w-current');
    expect(resolveLoginWorkspace).toHaveBeenCalledWith(USER_ID, 'w-current');
  });

  it('账号没有任何可用工作区时拒绝刷新（403，而不是签发一个没有工作区的令牌）', async () => {
    const { service, jwt } = build({ noWorkspace: true });
    const refresh = jwt.sign({ sub: USER_ID, type: 'refresh' }, { jwtid: 'jti-2', expiresIn: '7d' });

    await expect(service.refresh(refresh)).rejects.toThrow(/没有可用的工作区/);
  });
});
