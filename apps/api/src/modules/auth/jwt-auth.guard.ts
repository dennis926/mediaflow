import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUser } from './auth.types';
import { AuthSessionService } from './auth-session.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { WORKSPACE_LIFECYCLE_KEY } from './workspace-lifecycle.decorator';

/** 只读方法：归档态下仍然放行（查看历史，但不能改动） */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface JwtPayload {
  sub: string;
  /** 刷新令牌带 type='refresh'，只能用于换新令牌，不能直接访问业务接口 */
  type?: string;
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
    private readonly sessions: AuthSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = this.extractToken(request);

    if (token) {
      try {
        const payload = this.jwtService.verify<JwtPayload>(token);
        // 只接受"访问令牌"形态：刷新令牌没有角色信息，若被放行会退化成无角色身份。
        if (payload.type === 'refresh' || !payload.sub || !payload.workspaceId || !Array.isArray(payload.roles)) {
          throw new UnauthorizedException('令牌类型不正确，请重新登录');
        }
        /**
         * 令牌只证明"签名有效"，不证明"现在还允许"：
         * 停用账号 / 移出工作区 / 降权之后，旧令牌在有效期内也必须立即失去相应权限（审计 P1-2）。
         */
        const session = await this.sessions.resolve(payload.sub, payload.workspaceId);
        if (!session) throw new UnauthorizedException('账号不存在，请重新登录');
        if (!session.active) throw new UnauthorizedException('账号已被停用，请联系管理员');
        if (!session.member) throw new NotFoundException('你不是该工作区的成员，请切换工作区或联系管理员');

        /**
         * 工作区状态闸门（B0.4）：
         * - 已软删（或被永久清除）→ 404，与"非成员"一致，不暴露该工作区曾经存在
         * - 已归档 → 读放行、写 403（提示先取消归档）
         * 公开接口与生命周期接口豁免：前者不需要登录态，后者按"目标工作区"在服务层判权限。
         */
        const lifecycleRoute = this.reflector.getAllAndOverride<boolean>(WORKSPACE_LIFECYCLE_KEY, [
          context.getHandler(),
          context.getClass(),
        ]);
        if (!isPublic && !lifecycleRoute) {
          if (session.workspaceStatus === 'soft_deleted') {
            throw new NotFoundException('该工作区不存在或已被删除');
          }
          if (session.workspaceStatus === 'archived' && !READ_ONLY_METHODS.has(request.method)) {
            throw new ForbiddenException('工作区已归档（只读），请先取消归档后再操作');
          }
        }

        const tokenRoles = payload.roles as AuthUser['roles'];
        const drifted = tokenRoles.length !== session.roles.length
          || session.roles.some((role) => !tokenRoles.includes(role));
        if (drifted) {
          // 以数据库为准重建身份，并留痕（降权后旧令牌被使用的情况）
          void this.sessions.recordRoleDrift(
            { id: payload.sub, name: payload.displayName },
            payload.tenantId,
            payload.workspaceId,
            tokenRoles,
            session.roles,
          );
        }

        request.user = {
          id: payload.sub,
          email: payload.email,
          displayName: payload.displayName,
          tenantId: payload.tenantId,
          workspaceId: payload.workspaceId,
          roles: drifted ? session.roles : tokenRoles,
          isSuperAdmin: payload.isSuperAdmin,
          mustChangePassword: false,
        };
        return true;
      } catch (error) {
        // 权限/状态类错误（401/403/404）要原样抛出，不能退化成"登录状态失效"——
        // 否则"工作区已归档"会被误报成"请重新登录"，用户永远找不到真正原因
        if (
          error instanceof UnauthorizedException ||
          error instanceof ForbiddenException ||
          error instanceof NotFoundException
        ) {
          throw error;
        }
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
