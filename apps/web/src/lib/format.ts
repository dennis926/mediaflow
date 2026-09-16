import { AiFlagType, ContentStatus, PublishTaskStatus } from '@mediaflow/shared';

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatNumber(value?: number | null): string {
  if (value === undefined || value === null) return '0';
  return new Intl.NumberFormat('zh-CN').format(value);
}

export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  [ContentStatus.Draft]: '草稿',
  [ContentStatus.Reviewing]: '审核中',
  [ContentStatus.Approved]: '已通过',
  [ContentStatus.Rejected]: '已驳回',
  [ContentStatus.Archived]: '已归档',
};

export const CONTENT_STATUS_TONES: Record<ContentStatus, 'default' | 'info' | 'success' | 'danger' | 'warning'> = {
  [ContentStatus.Draft]: 'default',
  [ContentStatus.Reviewing]: 'warning',
  [ContentStatus.Approved]: 'success',
  [ContentStatus.Rejected]: 'danger',
  [ContentStatus.Archived]: 'info',
};

export const TASK_STATUS_LABELS: Record<PublishTaskStatus, string> = {
  [PublishTaskStatus.Pending]: '待发布',
  [PublishTaskStatus.Scheduled]: '已排期',
  [PublishTaskStatus.Publishing]: '发布中',
  [PublishTaskStatus.Published]: '已发布',
  [PublishTaskStatus.Failed]: '发布失败',
  [PublishTaskStatus.Canceled]: '已取消',
  [PublishTaskStatus.ManualRequired]: '待人工发布',
};

export const TASK_STATUS_TONES: Record<PublishTaskStatus, 'default' | 'info' | 'success' | 'danger' | 'warning' | 'brand'> = {
  [PublishTaskStatus.Pending]: 'default',
  [PublishTaskStatus.Scheduled]: 'info',
  [PublishTaskStatus.Publishing]: 'warning',
  [PublishTaskStatus.Published]: 'success',
  [PublishTaskStatus.Failed]: 'danger',
  [PublishTaskStatus.Canceled]: 'default',
  [PublishTaskStatus.ManualRequired]: 'brand',
};

export const AI_FLAG_LABELS: Record<AiFlagType, string> = {
  [AiFlagType.None]: '人工撰写',
  [AiFlagType.FullyGenerated]: 'AI 生成',
  [AiFlagType.Assisted]: 'AI 辅助',
  [AiFlagType.Translated]: 'AI 翻译',
};
