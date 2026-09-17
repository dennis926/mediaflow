import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityGuard } from '../capability.guard';
import { Capability } from '../capabilities';
import { applyRuntimeConfig } from '../../settings/runtime-config';

function contextFor(user: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardRequiring(capability: Parameters<typeof Capability>[0]): CapabilityGuard {
  const reflector = {
    getAllAndOverride: vi.fn(() => [capability]),
  } as unknown as Reflector;
  return new CapabilityGuard(reflector);
}

const admin = { id: 'u1', roles: ['admin'], isSuperAdmin: false };
const editor = { id: 'u2', roles: ['editor'], isSuperAdmin: false };
const viewer = { id: 'u3', roles: ['viewer'], isSuperAdmin: false };

describe('CapabilityGuard（可配置权限矩阵）', () => {
  afterEach(() => {
    // 每个用例结束后恢复默认矩阵，避免相互影响
    applyRuntimeConfig({});
  });

  it('默认矩阵：admin 可以改设置，editor 不可以', () => {
    expect(guardRequiring('settings.write').canActivate(contextFor(admin))).toBe(true);
    expect(() => guardRequiring('settings.write').canActivate(contextFor(editor))).toThrow(ForbiddenException);
    expect(() => guardRequiring('settings.write').canActivate(contextFor(viewer))).toThrow(ForbiddenException);
  });

  it('默认矩阵：editor 可以发布，reviewer 不行', () => {
    expect(guardRequiring('publish.execute').canActivate(contextFor(editor))).toBe(true);
    expect(() => guardRequiring('publish.execute').canActivate(contextFor({ roles: ['reviewer'] }))).toThrow(ForbiddenException);
  });

  it('super admin 始终放行', () => {
    expect(guardRequiring('users.privileged').canActivate(contextFor({ roles: [], isSuperAdmin: true }))).toBe(true);
  });

  it('改配置即时生效：把 settings.write 开放给 editor 后 editor 就通过了', () => {
    applyRuntimeConfig({
      PERMISSION_MATRIX: JSON.stringify({
        'settings.write': ['owner', 'admin', 'editor'],
        'publish.execute': ['owner', 'admin', 'editor'],
      }),
    });

    expect(guardRequiring('settings.write').canActivate(contextFor(editor))).toBe(true);
    // 未在配置里出现的能力点回退默认矩阵，行为不变
    expect(() => guardRequiring('users.manage').canActivate(contextFor(editor))).toThrow(ForbiddenException);
  });

  it('把某个能力收回给 owner 后，admin 也会被拦下', () => {
    applyRuntimeConfig({ PERMISSION_MATRIX: JSON.stringify({ 'settings.write': ['owner'] }) });

    expect(guardRequiring('settings.write').canActivate(contextFor({ roles: ['owner'] }))).toBe(true);
    expect(() => guardRequiring('settings.write').canActivate(contextFor(admin))).toThrow(ForbiddenException);
  });

  it('报错信息里说明允许的角色，便于排查', () => {
    try {
      guardRequiring('settings.write').canActivate(contextFor(viewer));
      throw new Error('应当抛出 ForbiddenException');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toContain('owner');
      expect((error as ForbiddenException).message).toContain('权限矩阵');
    }
  });

  it('没有标注能力点的接口不受影响', () => {
    const reflector = { getAllAndOverride: vi.fn(() => undefined) } as unknown as Reflector;
    const guard = new CapabilityGuard(reflector);
    expect(guard.canActivate(contextFor(viewer))).toBe(true);
  });
});
