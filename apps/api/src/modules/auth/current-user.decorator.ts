import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthUser } from './auth.types';

/** Reads the authenticated user that JwtAuthGuard attached to the request. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser | undefined => {
  const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
  return request.user;
});
