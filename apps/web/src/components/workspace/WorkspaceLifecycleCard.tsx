'use client';

import { hasCapability } from '../../lib/capabilities';
import { formatDateTime } from '../../lib/format';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Tag, type TagTone } from '../ui/Tag';
import styles from './workspace.module.css';

export type WorkspaceLifecycleStatus = 'active' | 'archived' | 'soft_deleted';

export interface WorkspaceLifecycleInfo {
  id: string;
  name: string;
  status: WorkspaceLifecycleStatus;
  archivedAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  /** 由后端算好（前端不自己算天数，避免时区/跨天算错） */
  daysUntilPurge: number | null;
}

export interface WorkspaceLifecycleCardProps {
  info: WorkspaceLifecycleInfo | null;
  /** 当前用户的能力点（来自 /auth/capabilities），按钮显隐完全由它决定 */
  capabilities: string[];
  loading?: boolean;
  busy?: 'archive' | 'unarchive' | 'delete' | 'restore' | null;
  error?: string | null;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onRestore: () => void;
}

const STATUS_META: Record<WorkspaceLifecycleStatus, { label: string; tone: TagTone; description: string }> = {
  active: {
    label: '正常',
    tone: 'success',
    description: '这个工作区可以正常读写：内容、任务、成员与设置都能改。',
  },
  archived: {
    label: '已归档（只读）',
    tone: 'warning',
    description: '归档只是"暂时停用"：历史数据都能查看，但不能新增或修改；随时可以取消归档，数据不会丢。',
  },
  soft_deleted: {
    label: '已删除（保留期内可恢复）',
    tone: 'danger',
    description: '工作区处于删除状态，成员暂时看不到它；在保留期内由所有者点"恢复"即可完整找回。',
  },
};

/** 恢复倒计时文案：到期日为 0 天时给出"今天到期"的明确提示，避免用户误以为还有很多天。 */
export function purgeCountdownText(daysUntilPurge: number | null): string {
  if (daysUntilPurge === null) return '';
  if (daysUntilPurge <= 0) return '今天到期：到期后数据将被永久清除，请立即恢复';
  return `还剩 ${daysUntilPurge} 天可恢复，到期后数据将被永久清除`;
}

/**
 * 工作区生命周期卡片：显示当前状态、恢复倒计时，并按能力点提供归档/取消归档/删除/恢复。
 *
 * 永久清除（purge）**不在这里提供**：它是不可逆的高危操作，只走接口 + 运维手册，
 * 需要时请联系管理员（见 RUNBOOK-purge演练.md）。
 */
export function WorkspaceLifecycleCard({
  info,
  capabilities,
  loading = false,
  busy = null,
  error = null,
  onArchive,
  onUnarchive,
  onDelete,
  onRestore,
}: WorkspaceLifecycleCardProps) {
  if (loading && !info) {
    return (
      <div data-testid="lifecycle-loading" className={styles.note}>
        正在读取工作区状态…
      </div>
    );
  }
  if (!info) {
    return (
      <div data-testid="lifecycle-missing" className={styles.note}>
        没有可管理的工作区。
      </div>
    );
  }

  const meta = STATUS_META[info.status] ?? STATUS_META.active;
  const canArchive = hasCapability(capabilities, 'workspace.archive');
  const canDelete = hasCapability(capabilities, 'workspace.delete');
  const canRestore = hasCapability(capabilities, 'workspace.restore');

  return (
    <div data-testid="workspace-lifecycle">
      <div className={styles.statusRow}>
        <span className={styles.meta}>当前工作区状态</span>
        <Tag tone={meta.tone}>{meta.label}</Tag>
        <span data-testid="lifecycle-status" hidden>
          {info.status}
        </span>
      </div>

      <p className={styles.description}>{meta.description}</p>

      {info.status === 'soft_deleted' ? (
        <div
          data-testid="purge-countdown"
          className={`${styles.countdown} ${(info.daysUntilPurge ?? 0) > 0 ? styles.countdownCalm : ''}`}
        >
          {purgeCountdownText(info.daysUntilPurge)}
        </div>
      ) : null}

      {info.status === 'archived' && info.archivedAt ? (
        <div className={styles.meta}>归档时间：{formatDateTime(info.archivedAt)}</div>
      ) : null}
      {info.status === 'soft_deleted' && info.deletedAt ? (
        <div className={styles.meta}>
          删除时间：{formatDateTime(info.deletedAt)}
          {info.purgeAfter ? ` · 到期时间：${formatDateTime(info.purgeAfter)}` : ''}
        </div>
      ) : null}

      {info.status === 'soft_deleted' && !canRestore ? (
        <div className={styles.meta} data-testid="restore-permission-note">
          只有工作区所有者可以恢复它，请联系管理员。
        </div>
      ) : null}

      {error ? (
        <div style={{ marginTop: 'var(--mf-space-3)' }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      <div className={styles.actions}>
        {info.status === 'active' && canArchive ? (
          <Button variant="secondary" loading={busy === 'archive'} onClick={onArchive}>
            归档工作区（只读）
          </Button>
        ) : null}
        {info.status === 'archived' && canArchive ? (
          <Button variant="secondary" loading={busy === 'unarchive'} onClick={onUnarchive}>
            取消归档
          </Button>
        ) : null}
        {info.status === 'soft_deleted' && canRestore ? (
          <Button loading={busy === 'restore'} onClick={onRestore}>
            恢复工作区
          </Button>
        ) : null}
        {info.status !== 'soft_deleted' && canDelete ? (
          <Button variant="danger" loading={busy === 'delete'} onClick={onDelete}>
            删除工作区
          </Button>
        ) : null}
      </div>

      <p className={styles.helperFooter}>
        提示：删除是「软删除」，保留期内可以恢复；<strong>永久清除</strong>（不可恢复）不在界面提供，如需彻底清除数据请联系管理员按运维手册操作。
      </p>
    </div>
  );
}
