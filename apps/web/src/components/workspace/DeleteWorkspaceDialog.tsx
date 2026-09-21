'use client';

import { useState } from 'react';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import styles from './workspace.module.css';

export interface DeleteWorkspaceDialogProps {
  open: boolean;
  workspaceName: string;
  /** 是否为最后一个可用工作区：是则要求额外勾选确认（软保护，不硬拦） */
  isLastWorkspace: boolean;
  /** 保留天数（用于文案），来自后端配置 */
  retentionDays?: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (payload: { confirmName: string; confirmLastWorkspace: boolean }) => void;
}

/**
 * 删除工作区确认框。
 *
 * 两道确认：①输入完整工作区名称；②若是最后一个工作区，必须勾选"我确认这是最后一个工作区"。
 * 后端只做**软删除**（保留期内可恢复），永久清除不在界面提供。
 */
export function DeleteWorkspaceDialog({
  open,
  workspaceName,
  isLastWorkspace,
  retentionDays = 30,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: DeleteWorkspaceDialogProps) {
  const [confirmName, setConfirmName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const nameMatches = confirmName.trim() === workspaceName;
  const canConfirm = nameMatches && (!isLastWorkspace || acknowledged) && !busy;

  const close = () => {
    setConfirmName('');
    setAcknowledged(false);
    onCancel();
  };

  return (
    <Dialog
      open={open}
      title={`删除工作区「${workspaceName}」`}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!canConfirm}
            onClick={() => onConfirm({ confirmName: confirmName.trim(), confirmLastWorkspace: acknowledged })}
          >
            确认删除
          </Button>
        </>
      }
    >
      <p className={styles.description}>
        删除后该工作区对成员不可见，数据进入保留期（默认 {retentionDays} 天）。保留期内由所有者执行「恢复」即可完整找回；
        超过保留期后系统会自动永久清除，届时不可恢复。
      </p>

      {isLastWorkspace ? (
        <div className={styles.dangerBox} data-testid="last-workspace-warning">
          这是你最后一个可用的工作区：删除后你将没有可进入的工作区，需要由所有者恢复它才能继续使用本系统。请确认后再继续。
        </div>
      ) : null}

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="delete-workspace-confirm">
          请输入工作区完整名称以确认：<strong>{workspaceName}</strong>
        </label>
        <input
          id="delete-workspace-confirm"
          className={styles.textInput}
          value={confirmName}
          onChange={(event) => setConfirmName(event.target.value)}
          placeholder={workspaceName}
          autoComplete="off"
        />
      </div>

      {isLastWorkspace ? (
        <label className={styles.checkboxRow} data-testid="last-workspace-ack">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          我确认这是最后一个工作区，并承担删除后的影响
        </label>
      ) : null}

      {error ? (
        <div style={{ marginTop: 'var(--mf-space-3)' }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      <p className={styles.helperFooter} data-testid="purge-exit-note">
        如需永久清除（不可恢复），请联系管理员按运维手册操作。
      </p>
    </Dialog>
  );
}
