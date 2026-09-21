'use client';

import { hasCapability } from '../../lib/capabilities';
import type { WorkspaceExportJobItem } from '../../lib/api/types';
import { formatDateTime } from '../../lib/format';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Tag } from '../ui/Tag';
import styles from './workspace.module.css';

/** 复用 API 类型定义，避免两处字段名漂移 */
export type ExportJobView = WorkspaceExportJobItem;

export interface WorkspaceExportPanelProps {
  capabilities: string[];
  job: ExportJobView | null;
  /** 一次性下载链接（15 分钟有效、用过即失效） */
  link?: { url: string; expiresAt: string } | null;
  busy?: 'request' | 'refresh' | 'link' | null;
  error?: string | null;
  onStart: () => void;
  onRefresh: () => void;
  onGetLink: () => void;
}

/** 字节数转可读文本（只用整数运算，避免不同浏览器对 toFixed 的显示差异）。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unitIndex]}`;
}

export function isExportExpired(expiresAt: string | null, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now;
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  completed: '已完成',
  failed: '失败',
};

/**
 * 数据导出面板：申请导出 → 查看进度 → 生成一次性下载链接。
 *
 * 两个必须写清楚的时间约定（否则用户以为拿到了长期可用的文件）：
 *   1. 导出产物 7 天后自动删除；
 *   2. 下载链接 15 分钟内有效且只能使用一次。
 * 没有导出能力点的用户看不到这个面板（按钮显隐由能力点决定，不写死角色）。
 */
export function WorkspaceExportPanel({
  capabilities,
  job,
  link = null,
  busy = null,
  error = null,
  onStart,
  onRefresh,
  onGetLink,
}: WorkspaceExportPanelProps) {
  if (!hasCapability(capabilities, 'workspace.export')) return null;

  const expired = isExportExpired(job?.expiresAt ?? null);
  const running = job?.status === 'queued' || job?.status === 'running';

  return (
    <div data-testid="workspace-export-panel">
      <Banner tone="info">
        <span>
          导出内容为 ZIP 包（含内容、任务、素材、知识库、审计与清单文件），用于交接与自备份。
          <strong>导出产物将在 7 天后自动删除，请及时下载。</strong>
        </span>
      </Banner>

      {job ? (
        <div className={styles.statGrid}>
          <div className={styles.statItem}>
            <span className={styles.statLabel}>任务状态</span>
            <span className={styles.statValue}>
              <Tag tone={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : 'info'}>
                {STATUS_LABEL[job.status] ?? job.status}
              </Tag>
            </span>
          </div>
          <div className={styles.statItem}>
            <span className={styles.statLabel}>申请时间</span>
            <span className={styles.statValue}>{formatDateTime(job.createdAt)}</span>
          </div>
          {job.sizeBytes !== null ? (
            <div className={styles.statItem}>
              <span className={styles.statLabel}>文件大小</span>
              <span className={styles.statValue} data-testid="export-size">
                {formatBytes(job.sizeBytes)}
              </span>
            </div>
          ) : null}
          {job.checksum ? (
            <div className={styles.statItem}>
              <span className={styles.statLabel}>校验值（sha256 前 12 位）</span>
              <span className={styles.statValue} data-testid="export-checksum">
                {job.checksum.slice(0, 12)}
              </span>
            </div>
          ) : null}
          {job.expiresAt ? (
            <div className={styles.statItem}>
              <span className={styles.statLabel}>产物有效期至</span>
              <span className={styles.statValue} data-testid="export-expires">
                {formatDateTime(job.expiresAt)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {running ? (
        <div style={{ marginBottom: 'var(--mf-space-3)' }} data-testid="export-progress">
          <div className={styles.meta}>正在生成（{Math.max(0, Math.min(100, job?.progress ?? 0))}%）</div>
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} style={{ width: `${Math.max(3, Math.min(100, job?.progress ?? 0))}%` }} />
          </div>
        </div>
      ) : null}

      {job?.status === 'failed' ? (
        <Banner tone="danger">{job.error ?? '导出失败，请稍后重试。'}</Banner>
      ) : null}

      {job?.status === 'completed' && expired ? (
        <Banner tone="warning">
          <span data-testid="export-expired">产物已过期（导出产物保留 7 天），请重新申请导出。</span>
        </Banner>
      ) : null}

      {error ? (
        <div style={{ marginTop: 'var(--mf-space-3)' }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      {link ? (
        <div className={styles.linkBox} data-testid="export-link">
          <span className={styles.note}>此链接 15 分钟内有效且仅能使用一次。</span>
          <a className={styles.linkUrl} href={link.url} target="_blank" rel="noreferrer">
            {link.url}
          </a>
          <span className={styles.note}>
            链接过期时间：{formatDateTime(link.expiresAt)} · 若下载中断需要重新申请链接（不能重复使用同一个）。
          </span>
        </div>
      ) : null}

      <div className={styles.actions}>
        <Button loading={busy === 'request'} disabled={running} onClick={onStart}>
          {job ? '重新申请导出' : '申请导出'}
        </Button>
        {running ? (
          <Button variant="secondary" loading={busy === 'refresh'} onClick={onRefresh}>
            刷新进度
          </Button>
        ) : null}
        {job?.status === 'completed' && !expired ? (
          <Button variant="secondary" loading={busy === 'link'} onClick={onGetLink}>
            获取下载链接
          </Button>
        ) : null}
      </div>

      <p className={styles.helperFooter}>
        说明：同一工作区同时只允许 1 个导出任务；单次导出上限 5GB，超出会被拒绝（不会生成残缺文件）。
      </p>
    </div>
  );
}
