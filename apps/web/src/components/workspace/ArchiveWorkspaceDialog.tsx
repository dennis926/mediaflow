'use client';

import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import styles from './workspace.module.css';

export interface ArchiveWorkspaceDialogProps {
  open: boolean;
  workspaceName: string;
  /** archive：归档；unarchive：取消归档 */
  mode: 'archive' | 'unarchive';
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 归档/取消归档确认框：强调"可逆"，不制造误操作的恐慌。 */
export function ArchiveWorkspaceDialog({
  open,
  workspaceName,
  mode,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: ArchiveWorkspaceDialogProps) {
  const archiving = mode === 'archive';
  return (
    <Dialog
      open={open}
      title={archiving ? `归档工作区「${workspaceName}」` : `取消归档「${workspaceName}」`}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button loading={busy} onClick={onConfirm}>
            {archiving ? '确认归档' : '确认取消归档'}
          </Button>
        </>
      }
    >
      <p className={styles.description}>
        {archiving
          ? '归档后该工作区变为只读：内容、任务、成员与设置都无法修改，但历史数据全部保留，成员随时可以查看。'
          : '取消归档后该工作区恢复为可读写状态。'}
      </p>
      <div className={styles.dangerBox} data-testid="archive-reversible-note">
        {archiving ? '这是可逆操作：归档不会删除任何数据，随时可以取消归档。' : '取消归档后可继续正常使用这个工作区。'}
      </div>
      {error ? (
        <div style={{ marginTop: 'var(--mf-space-3)' }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}
    </Dialog>
  );
}
