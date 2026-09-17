import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth.types';
import { CAPABILITY_KEY, CAPABILITY_LABELS, Capability, rolesForCapability } from './capabilities';

/**
 * 能力守卫：与角色守卫并存。
 *
 * 差别在于——@Roles 把角色清单写死在代码里，@Capability 读的是
 * 可配置的权限矩阵（设置 → 站点信息 → 权限矩阵），换一家公司可以自己决定
 * 谁能改设置、谁能审核、谁能发布。默认矩阵与旧的 @Roles 行为一致。
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability[]>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('缺少登录信息，请重新登录');
    if (user.isSuperAdmin) return true;

    for (const capability of required) {
      const allowed = rolesForCapability(capability);
      if (allowed.length === 0) continue;
      if (user.roles.some((role) => allowed.includes(role))) return true;
    }

    const names = required.map((capability) => CAPABILITY_LABELS[capability] ?? capability).join('、');
    const allowedRoles = [...new Set(required.flatMap((capability) => rolesForCapability(capability)))];
    throw new ForbiddenException(
      `当前角色（${user.roles.join('、') || '无角色'}）无权${names}，允许的角色：${allowedRoles.join('、')}（可在「设置 → 站点信息 → 权限矩阵」中调整）`,
    );
  }
}
