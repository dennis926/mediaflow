import { SetMetadata } from '@nestjs/common';
import { RoleCode } from '../workspace/entities/role.entity';
import { runtime } from '../settings/runtime-config';

export const CAPABILITY_KEY = 'mediaflow:capability';

/** 可配置的能力点：把"谁能做什么"从代码里的角色清单变成一份可改的权限矩阵。 */
export type Capability =
  | 'settings.write'
  | 'users.manage'
  | 'users.privileged'
  | 'content.write'
  | 'content.review'
  | 'content.archive'
  | 'publish.execute'
  | 'knowledge.write'
  | 'platform.bind'
  | 'analytics.sync'
  | 'audit.read'
  | 'workspace.manage'
  // B0.4 工作区生命周期（归档 → 软删 → 恢复 → 硬删）
  | 'workspace.archive'
  | 'workspace.delete'
  | 'workspace.restore'
  | 'workspace.export'
  | 'workspace.purge';

export const CAPABILITIES: Capability[] = [
  'settings.write',
  'users.manage',
  'users.privileged',
  'content.write',
  'content.review',
  'content.archive',
  'publish.execute',
  'knowledge.write',
  'platform.bind',
  'analytics.sync',
  'audit.read',
  'workspace.manage',
  'workspace.archive',
  'workspace.delete',
  'workspace.restore',
  'workspace.export',
  'workspace.purge',
];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'settings.write': '修改系统设置',
  'users.manage': '管理用户（创建/启用/改资料）',
  'users.privileged': '删除用户与调整角色（高危）',
  'content.write': '创建与编辑内容',
  'content.review': '审核内容',
  'content.archive': '归档/取消归档内容',
  'publish.execute': '创建/重试/取消发布任务',
  'knowledge.write': '维护知识库与分类',
  'platform.bind': '绑定/解绑平台账号',
  'analytics.sync': '同步平台数据',
  'audit.read': '查看审计日志',
  'workspace.manage': '管理工作区与成员',
  'workspace.archive': '归档/取消归档工作区（只读，可随时撤销）',
  'workspace.delete': '删除工作区（软删，保留期内可恢复）',
  'workspace.restore': '恢复已删除的工作区',
  'workspace.export': '导出工作区数据（只读，便于交接与备份）',
  'workspace.purge': '永久清除工作区数据（不可逆，高危）',
};

/** 默认矩阵：与改造前的 @Roles 行为完全一致，改配置后即可按公司需要调整。 */
export const DEFAULT_PERMISSION_MATRIX: Record<Capability, RoleCode[]> = {
  'settings.write': ['owner', 'admin'],
  'users.manage': ['owner', 'admin'],
  'users.privileged': ['owner'],
  'content.write': ['owner', 'admin', 'editor'],
  'content.review': ['owner', 'admin', 'reviewer'],
  'content.archive': ['owner', 'admin', 'editor'],
  'publish.execute': ['owner', 'admin', 'editor'],
  'knowledge.write': ['owner', 'admin', 'editor'],
  'platform.bind': ['owner', 'admin'],
  'analytics.sync': ['owner', 'admin'],
  'audit.read': ['owner', 'admin'],
  'workspace.manage': ['owner', 'admin'],
  // 生命周期：导出是只读操作，允许 admin；删除/恢复/归档/永久清除仅 owner
  'workspace.archive': ['owner'],
  'workspace.delete': ['owner'],
  'workspace.restore': ['owner'],
  'workspace.export': ['owner', 'admin'],
  'workspace.purge': ['owner'],
};

export const DEFAULT_ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '内容编辑',
  reviewer: '审核员',
  viewer: '只读',
};

/** 取某个能力允许的角色：优先用配置，缺失时回退默认矩阵。 */
export function rolesForCapability(capability: Capability): RoleCode[] {
  const configured = runtime().permissions.matrix[capability];
  if (Array.isArray(configured)) return configured as RoleCode[];
  return DEFAULT_PERMISSION_MATRIX[capability] ?? [];
}

/** 角色显示名：可以在设置里按公司习惯改（例如 admin → 运营主管）。 */
export function roleLabel(code: string, fallback?: string): string {
  return runtime().permissions.roleLabels[code] ?? fallback ?? DEFAULT_ROLE_LABELS[code] ?? code;
}

/** 多角色时的展示优先级（前端只展示一个"主角色"）。 */
const PRIMARY_ROLE_ORDER: RoleCode[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer'];

export function primaryRole(roles: RoleCode[]): RoleCode | null {
  return PRIMARY_ROLE_ORDER.find((role) => roles.includes(role)) ?? roles[0] ?? null;
}

/**
 * 算某个身份真正生效的能力点集合（供 /auth/capabilities 与前端按钮显隐使用）。
 *
 * 判定必须与 CapabilityGuard 逐条一致，否则前端会显示一个后端并不放行的按钮，
 * 或反过来把本可用的按钮藏起来（用户就再也找不到入口）：
 * - 超级管理员：全部能力
 * - 矩阵中该能力未配置任何角色（长度为 0）：守卫视为"不限制"，这里同样视为生效
 * - 其余：角色集合与矩阵有交集即生效
 */
export function capabilitiesForRoles(roles: RoleCode[], isSuperAdmin = false): Capability[] {
  return CAPABILITIES.filter((capability) => {
    if (isSuperAdmin) return true;
    const allowed = rolesForCapability(capability);
    if (allowed.length === 0) return true;
    return roles.some((role) => allowed.includes(role));
  });
}

/** Restricts a route to the roles allowed by the configurable permission matrix. */
export const Capability = (...capabilities: Capability[]): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY_KEY, capabilities);
