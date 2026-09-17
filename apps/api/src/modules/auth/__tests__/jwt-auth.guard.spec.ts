import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../jwt-auth.guard';

function buildGuard(secret = 'test-secret'): { guard: JwtAuthGuard; jwt: JwtService } {
  const jwt = new JwtService({ secret });
  const reflector = { getAllAndOverride: vi.fn(() => false) } as unknown as Reflector;
  const config = { get: vi.fn(() => undefined) } as unknown as ConfigService;
  return { guard: new JwtAuthGuard(jwt, reflector, config), jwt };
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

describe('JwtAuthGuard 令牌校验', () => {
  it('接受正常访问令牌', () => {
    const { guard, jwt } = buildGuard();
    const token = jwt.sign({ sub: 'u1', email: 'a@b.c', displayName: 'A', tenantId: 't', workspaceId: 'w', roles: ['owner'], isSuperAdmin: false });
    const { context, request } = contextWithToken(token);

    expect(guard.canActivate(context)).toBe(true);
    expect((request.user as { workspaceId: string }).workspaceId).toBe('w');
  });

  it('拒绝刷新令牌（否则会退化成无角色身份）', () => {
    const { guard, jwt } = buildGuard();
    const refreshToken = jwt.sign({ sub: 'u1', type: 'refresh' });
    const { context } = contextWithToken(refreshToken);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('拒绝缺少工作区或角色的令牌', () => {
    const { guard, jwt } = buildGuard();
    const missingWorkspace = jwt.sign({ sub: 'u1', roles: ['owner'] });
    expect(() => guard.canActivate(contextWithToken(missingWorkspace).context)).toThrow(UnauthorizedException);

    const missingRoles = jwt.sign({ sub: 'u1', workspaceId: 'w' });
    expect(() => guard.canActivate(contextWithToken(missingRoles).context)).toThrow(UnauthorizedException);
  });

  it('拒绝伪造/过期令牌', () => {
    const { guard } = buildGuard();
    const other = new JwtService({ secret: 'another-secret' });
    const forged = other.sign({ sub: 'u1', workspaceId: 'w', roles: ['owner'] });
    expect(() => guard.canActivate(contextWithToken(forged).context)).toThrow(UnauthorizedException);
  });

  it('无令牌时拒绝访问受保护接口', () => {
    const { guard } = buildGuard();
    expect(() => guard.canActivate(contextWithToken(null).context)).toThrow(UnauthorizedException);
  });
});
