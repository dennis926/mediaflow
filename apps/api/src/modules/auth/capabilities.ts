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
  | 'publish.execute'
  | 'knowledge.write'
  | 'platform.bind'
  | 'analytics.sync';

export const CAPABILITIES: Capability[] = [
  'settings.write',
  'users.manage',
  'users.privileged',
  'content.write',
  'content.review',
  'publish.execute',
  'knowledge.write',
  'platform.bind',
  'analytics.sync',
];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'settings.write': '修改系统设置',
  'users.manage': '管理用户（创建/启用/改资料）',
  'users.privileged': '删除用户与调整角色（高危）',
  'content.write': '创建与编辑内容',
  'content.review': '审核内容',
  'publish.execute': '创建/重试/取消发布任务',
  'knowledge.write': '维护知识库与分类',
  'platform.bind': '绑定/解绑平台账号',
  'analytics.sync': '同步平台数据',
};

/** 默认矩阵：与改造前的 @Roles 行为完全一致，改配置后即可按公司需要调整。 */
export const DEFAULT_PERMISSION_MATRIX: Record<Capability, RoleCode[]> = {
  'settings.write': ['owner', 'admin'],
  'users.manage': ['owner', 'admin'],
  'users.privileged': ['owner'],
  'content.write': ['owner', 'admin', 'editor'],
  'content.review': ['owner', 'admin', 'reviewer'],
  'publish.execute': ['owner', 'admin', 'editor'],
  'knowledge.write': ['owner', 'admin', 'editor'],
  'platform.bind': ['owner', 'admin'],
  'analytics.sync': ['owner', 'admin'],
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

/** Restricts a route to the roles allowed by the configurable permission matrix. */
export const Capability = (...capabilities: Capability[]): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY_KEY, capabilities);
