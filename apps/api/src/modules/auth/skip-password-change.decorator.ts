import { SetMetadata } from '@nestjs/common';

export const SKIP_PASSWORD_CHANGE_KEY = 'mediaflow:skip-password-change';

/**
 * 标记"持有临时密码时也必须放行"的接口。
 *
 * 守卫默认会拦住未改密的临时密码会话（P1-4）。白名单本身已经覆盖了改密、读自己、
 * 登出/续期、切换工作区等必需路由；本装饰器用于那些**必须在改密前可达**的补充场景
 * （例如按目标工作区判权的生命周期接口）。
 */
export const SkipPasswordChange = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_PASSWORD_CHANGE_KEY, true);
