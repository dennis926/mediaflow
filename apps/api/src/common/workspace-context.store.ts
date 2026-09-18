import { AsyncLocalStorage } from 'node:async_hooks';

export interface WorkspaceScope {
  tenantId: string;
  workspaceId: string;
}

/**
 * 请求级工作区作用域。
 *
 * 之前 WorkspaceContextService 直接缓存"数据库里第一个工作区"并给所有请求复用，
 * 单一工作区时看不出问题，一旦有第二个工作区就会**串数据**（A 公司的工作区能看到 B 公司的内容）。
 * 现在：每个请求由拦截器把令牌里的工作区写进 AsyncLocalStorage，业务代码读到的就是当前请求的工作区；
 * 后台任务（cron / 队列 worker）用 runAs() 显式指定作用域，没有作用域时回退到默认工作区。
 */
export const workspaceScopeStorage = new AsyncLocalStorage<WorkspaceScope>();

/** 在当前异步上下文里执行 fn，并把它标记为指定工作区。 */
export function runInWorkspaceScope<T>(scope: WorkspaceScope, fn: () => T): T {
  return workspaceScopeStorage.run(scope, fn);
}

/** 读取当前作用域（没有则返回 undefined，由调用方决定回退策略）。 */
export function currentWorkspaceScope(): WorkspaceScope | undefined {
  return workspaceScopeStorage.getStore();
}
