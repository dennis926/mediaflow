'use client';

import { useQuery } from '@tanstack/react-query';
import { authApi } from './api/endpoints';
import type { CapabilitiesView } from './api/types';

/**
 * 与后端 `apps/api/src/modules/auth/capabilities.ts` 一一对应的能力点。
 *
 * 前端只判断"有没有这个能力点"，绝不写角色名：换一家公司改了权限矩阵（谁能删工作区、
 * 谁能导出），界面上的按钮会自动跟着变，不需要改前端代码。
 */
export type Capability =
  | 'settings.write'
  | 'users.manage'
  | 'users.privileged'
  | 'content.write'
  | 'content.review'
  | 'content.archive'
  | 'publish.execute'
  | 'knowledge.write'
  | 'platform.bind'
  | 'analytics.sync'
  | 'audit.read'
  | 'workspace.manage'
  | 'workspace.archive'
  | 'workspace.delete'
  | 'workspace.restore'
  | 'workspace.export'
  | 'workspace.purge';

export function hasCapability(capabilities: readonly string[] | undefined, capability: Capability): boolean {
  return Boolean(capabilities?.includes(capability));
}

/**
 * 当前登录用户在当前工作区生效的能力点。
 *
 * 后端按数据库里的角色实时计算（30 秒缓存，权限变更时会主动失效），
 * 且只返回调用者自己的——所以任何登录用户都可以安全地读它。
 */
export function useCapabilities() {
  return useQuery({
    queryKey: ['auth', 'capabilities'],
    queryFn: () => authApi.capabilities(),
    staleTime: 30_000,
  });
}

export type { CapabilitiesView };
