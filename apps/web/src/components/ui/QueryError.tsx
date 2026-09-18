'use client';

import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ApiError } from '../../lib/api/client';
import { WarningIcon } from '../../lib/icons';

export interface QueryErrorProps {
  error: unknown;
  onRetry?: () => void;
  /** 出错时的动作名，例如"加载内容列表" */
  action?: string;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

/**
 * 查询失败的统一错误态。
 *
 * 以前列表页在请求失败时会退化成"还没有数据"的空态，用户会以为数据被删了（实际是接口出错）。
 * 现在失败就明确说"加载失败 + 原因 + 重试"。
 */
export function QueryError({ error, onRetry, action = '加载数据' }: QueryErrorProps) {
  const message = describe(error);
  const unauthorized = error instanceof ApiError && (error.status === 401 || error.status === 403);

  return (
    <EmptyState
      title={`${action}失败`}
      description={
        unauthorized
          ? `权限不足或登录已失效：${message}`
          : `${message}。这通常是网络或服务端问题，数据没有被删除，可以重试。`
      }
      icon={<WarningIcon width={22} height={22} />}
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    />
  );
}
