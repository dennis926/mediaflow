import { SetMetadata } from '@nestjs/common';

export const WORKSPACE_LIFECYCLE_KEY = 'mediaflow:workspace-lifecycle';

/**
 * 标记"工作区生命周期"接口（归档/取消归档/删除/恢复/导出/永久清除）。
 *
 * 守卫默认会按**当前令牌所在工作区**的状态拦请求：
 * 已软删 → 404、已归档 → 写操作 403。
 * 但生命周期接口的目标是某个具体工作区（可能正是已被软删的那个），
 * 若一并拦截，用户将永远无法恢复自己被删的工作区——所以这些接口必须豁免状态闸门，
 * 改为在服务层用 requireWorkspaceRole(目标工作区) 判定权限。
 */
export const WorkspaceLifecycle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(WORKSPACE_LIFECYCLE_KEY, true);
