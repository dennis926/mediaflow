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
  expiresIn: string;
  user: AuthUser;
}
