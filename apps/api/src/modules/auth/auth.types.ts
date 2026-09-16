import { RoleCode } from '../workspace/entities/role.entity';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  workspaceId: string;
  roles: RoleCode[];
  isSuperAdmin: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: string;
  user: AuthUser;
}
