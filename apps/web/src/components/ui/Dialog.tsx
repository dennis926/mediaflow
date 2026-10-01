'use client';

import { useEffect, type ReactNode } from 'react';
import { CloseIcon } from '../../lib/icons';
import styles from './ui.module.css';

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  /** 必填弹窗：不允许通过遮罩、Esc 或右上角关闭（例如强制修改初始密码）。 */
  dismissible?: boolean;
}

export function Dialog({ open, title, onClose, footer, children, dismissible = true }: DialogProps) {
  const close = dismissible ? onClose : undefined;

  useEffect(() => {
    if (!open || !close) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onClick={(event) => {
        if (close && event.target === event.currentTarget) close();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : '对话框'}>
        <header className={styles.dialogHeader}>
          <h2 className={styles.dialogTitle}>{title}</h2>
          {close ? (
            <button type="button" className={styles.iconButton} onClick={close} aria-label="关闭">
              <CloseIcon />
            </button>
          ) : null}
        </header>
        <div className={styles.dialogBody}>{children}</div>
        {footer ? <footer className={styles.dialogFooter}>{footer}</footer> : null}
      </div>
    </div>
  );
}
