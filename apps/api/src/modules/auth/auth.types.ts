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
  /** 令牌唯一 id：登出与轮换时用它把旧令牌加入黑名单 */
  jti?: string;
  /** 过期时间（秒，JWT 标准声明），黑名单 TTL 用它算剩余有效期 */
  exp?: number;
  iat?: number;
}
