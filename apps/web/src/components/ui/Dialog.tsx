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
}

export function Dialog({ open, title, onClose, footer, children }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : '对话框'}>
        <header className={styles.dialogHeader}>
          <h2 className={styles.dialogTitle}>{title}</h2>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </header>
        <div className={styles.dialogBody}>{children}</div>
        {footer ? <footer className={styles.dialogFooter}>{footer}</footer> : null}
      </div>
    </div>
  );
}
