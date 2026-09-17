import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth.types';
import { ROLES_KEY } from './roles.decorator';
import { RoleCode } from '../workspace/entities/role.entity';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('缺少登录信息，请重新登录');
    if (user.isSuperAdmin) return true;
    if (user.roles.some((role) => required.includes(role))) return true;
    // 提示里带上需要的角色，方便排查（此前写死"无权修改系统配置"，在非设置类接口上会误导）
    throw new ForbiddenException(`当前角色（${user.roles.join('、') || '无角色'}）无权执行该操作，需要：${required.join('、')}`);
  }
}
