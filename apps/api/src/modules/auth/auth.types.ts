import { WorkspaceStatus } from '../workspace/entities/workspace.entity';
import { RoleCode } from '../workspace/entities/role.entity';
import { Capability } from './capabilities';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  workspaceId: string;
  roles: RoleCode[];
  isSuperAdmin: boolean;
  /** true 时前端应提示用户立即修改密码（管理员重置/邀请生成的临时密码）。 */
  mustChangePassword: boolean;
}

/**
 * 当前登录用户"在某个工作区"生效的能力点（GET /auth/capabilities）。
 *
 * 只描述调用者自己：不读他人角色、不暴露全局权限矩阵，
 * 因此任何登录用户都可以安全地读它（前端据此决定按钮显隐，而不是把角色名写死在组件里）。
 */
export interface CapabilitiesView {
  /** 生效的工作区：通常等于当前令牌所在工作区；当前工作区已被删除时是"该用户为 owner 的软删工作区" */
  workspaceId: string;
  /** 主角色（多角色时按 owner > admin > editor > reviewer > viewer 取第一个；无角色为 null） */
  role: RoleCode | null;
  /** 全部角色 */
  roles: RoleCode[];
  capabilities: Capability[];
  /** 生效工作区的生命周期状态（soft_deleted 时前端要显示"恢复"入口） */
  workspaceStatus: WorkspaceStatus;
  isSuperAdmin: boolean;
}

export interface LoginResult {
  accessToken: string;
  /** 用于免登录续期；有效期见配置 AUTH_REFRESH_EXPIRES */
  refreshToken: string;
  expiresIn: string;
  user: AuthUser;
}

/** 刷新令牌的载荷：type 标记避免拿刷新令牌直接访问业务接口。 */
export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  /** 令牌唯一 id：登出与轮换时用它把旧令牌加入黑名单 */
  jti?: string;
  /** 过期时间（秒，JWT 标准声明），黑名单 TTL 用它算剩余有效期 */
  exp?: number;
  /**
   * 签发时的工作区（B0.4）：刷新时保持在同一工作区，而不是把用户切回"默认工作区"。
   * 老令牌没有这个字段 → 刷新时按成员关系重新解析（向后兼容）。
   */
  workspaceId?: string;
  /** 签发时的租户，用于登出审计（老令牌可能没有） */
  tenantId?: string;
  iat?: number;
}
