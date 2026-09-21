import { ApiError } from './api/client';

export type LifecycleAction = 'archive' | 'unarchive' | 'delete' | 'restore' | 'export';

const FALLBACK: Record<LifecycleAction, string> = {
  archive: '归档失败',
  unarchive: '取消归档失败',
  delete: '删除失败',
  restore: '恢复失败',
  export: '导出申请失败',
};

/**
 * 生命周期/导出操作失败的统一文案：把后端错误码翻译成"用户能照做的下一步"。
 *
 * 为什么不直接显示后端消息：409（还有未完成的任务）、410（超过保留期）、413（超过 5GB）
 * 这三类必须给出可操作的指引，否则用户只会反复点同一个按钮。
 */
export function describeLifecycleError(error: unknown, action: LifecycleAction): string {
  if (!(error instanceof ApiError)) return FALLBACK[action];
  switch (error.status) {
    case 403:
      return error.message || '当前角色没有该操作权限（可在「设置 → 站点信息 → 权限矩阵」中调整）';
    case 404:
      return '工作区不存在或你不是它的成员';
    case 409:
      return action === 'export'
        ? '该工作区已有导出任务在进行中，请等待它完成后再试'
        : `${error.message}（未完成的发布任务可到「发布队列」处理后再删）`;
    case 410:
      return '该工作区已超过保留期，数据不可恢复';
    case 413:
      return '导出数据超过 5GB 上限，请先清理素材后再试（系统不会生成残缺文件）';
    default:
      return error.message || '操作失败，请稍后重试';
  }
}
