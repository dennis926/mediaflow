import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthUser } from '../modules/auth/auth.types';
import { runInWorkspaceScope } from './workspace-context.store';

/**
 * 把当前登录用户的工作区（来自 JWT）绑定到这个请求的异步上下文。
 * 必须放在守卫之后（拦截器天然如此），这样 request.user 已经存在。
 */
@Injectable()
export class WorkspaceScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user?.workspaceId || !user.tenantId) {
      // 公开接口（健康检查、登录、公开站点配置）没有用户，走默认作用域
      return next.handle();
    }
    return runInWorkspaceScope({ tenantId: user.tenantId, workspaceId: user.workspaceId }, () => next.handle());
  }
}
