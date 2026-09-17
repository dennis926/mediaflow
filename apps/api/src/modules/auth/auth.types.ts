import { RoleCode } from '../workspace/entities/role.entity';

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
}
