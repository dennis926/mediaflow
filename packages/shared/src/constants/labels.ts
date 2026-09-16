import { AiFlagType, ContentStatus, PublishTaskStatus } from '../types/content';

export type LabelTone = 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  [ContentStatus.Draft]: '草稿',
  [ContentStatus.Reviewing]: '审核中',
  [ContentStatus.Approved]: '已通过',
  [ContentStatus.Rejected]: '已驳回',
  [ContentStatus.Archived]: '已归档',
};

export const CONTENT_STATUS_TONES: Record<ContentStatus, LabelTone> = {
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

export const TASK_STATUS_TONES: Record<PublishTaskStatus, LabelTone> = {
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
