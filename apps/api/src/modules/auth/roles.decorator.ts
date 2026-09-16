import { SetMetadata } from '@nestjs/common';
import { RoleCode } from '../workspace/entities/role.entity';

export const ROLES_KEY = 'mediaflow:roles';

/** Restricts a route to the given role codes (see RoleCode). */
export const Roles = (...roles: RoleCode[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
