import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUser } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

interface JwtPayload {
  sub: string;
  email: string;
  displayName: string;
  tenantId: string;
  workspaceId: string;
  roles: AuthUser['roles'];
  isSuperAdmin: boolean;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = this.extractToken(request);

    if (token) {
      try {
        const payload = this.jwtService.verify<JwtPayload>(token);
        request.user = {
          id: payload.sub,
          email: payload.email,
          displayName: payload.displayName,
          tenantId: payload.tenantId,
          workspaceId: payload.workspaceId,
          roles: payload.roles,
          isSuperAdmin: payload.isSuperAdmin,
          mustChangePassword: false,
        };
        return true;
      } catch {
        if (!isPublic) throw new UnauthorizedException('登录状态已失效，请重新登录');
      }
    }

    if (isPublic) return true;

    // Local development escape hatch: set AUTH_ENFORCED=false to explore the API without a token.
    if (this.config.get<string>('AUTH_ENFORCED') === 'false') return true;

    throw new UnauthorizedException('未登录或缺少访问令牌');
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
