import { describe, expect, it } from 'vitest';
import { RoleCode } from '../../workspace/entities/role.entity';
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  capabilitiesForRoles,
  primaryRole,
  rolesForCapability,
} from '../capabilities';

const ROLES: RoleCode[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer'];

/** 与 CapabilityGuard 相同的判定（把守卫的逻辑抄成一行，用来做"两边必须一致"的不变量测试）。 */
function guardWouldAllow(capability: (typeof CAPABILITIES)[number], roles: RoleCode[], isSuperAdmin = false): boolean {
  if (isSuperAdmin) return true;
  const allowed = rolesForCapability(capability);
  if (allowed.length === 0) return true;
  return roles.some((role) => allowed.includes(role));
}

describe('能力点计算（/auth/capabilities 的数据来源）', () => {
  it('每个能力点的中文说明都齐全（前端要展示给用户看）', () => {
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_LABELS[capability], capability).toBeTruthy();
    }
  });

  it('与能力守卫逐条一致：任意角色组合下，前端看到的按钮 = 后端真正放行的操作', () => {
    const combinations: RoleCode[][] = [
      [],
      ...ROLES.map((role) => [role]),
      ['owner', 'viewer'],
      ['admin', 'editor'],
      ['reviewer', 'viewer'],
      ROLES,
    ];
    for (const roles of combinations) {
      const effective = capabilitiesForRoles(roles);
      for (const capability of CAPABILITIES) {
        expect(effective.includes(capability), `${capability} / ${roles.join('+') || '无角色'}`).toBe(
          guardWouldAllow(capability, roles),
        );
      }
    }
  });

  it('只读角色拿不到任何高危能力点（删除/归档/恢复/导出/永久清除）', () => {
    const capabilities = capabilitiesForRoles(['viewer']);
    for (const dangerous of ['workspace.delete', 'workspace.archive', 'workspace.restore', 'workspace.export', 'workspace.purge'] as const) {
      expect(capabilities, dangerous).not.toContain(dangerous);
    }
    expect(capabilities).not.toContain('content.write');
    expect(capabilities).not.toContain('settings.write');
  });

  it('所有者拿到生命周期四件套 + 永久清除；管理员拿到导出但拿不到删除/清除', () => {
    const owner = capabilitiesForRoles(['owner']);
    expect(owner).toEqual(expect.arrayContaining(['workspace.archive', 'workspace.delete', 'workspace.restore', 'workspace.export', 'workspace.purge']));

    const admin = capabilitiesForRoles(['admin']);
    expect(admin).toContain('workspace.export');
    expect(admin).not.toContain('workspace.delete');
    expect(admin).not.toContain('workspace.purge');
    expect(admin).not.toContain('workspace.restore');
  });

  it('超级管理员拥有全部能力点', () => {
    expect(capabilitiesForRoles([], true)).toHaveLength(CAPABILITIES.length);
  });

  it('主角色按 owner > admin > editor > reviewer > viewer 取；无角色为 null', () => {
    expect(primaryRole(['viewer', 'owner'])).toBe('owner');
    expect(primaryRole(['viewer', 'editor'])).toBe('editor');
    expect(primaryRole(['reviewer'])).toBe('reviewer');
    expect(primaryRole([])).toBeNull();
  });
});
