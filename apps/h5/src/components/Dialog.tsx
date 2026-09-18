import { useEffect, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button with the danger palette. */
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Bottom-sheet dialog used for reason input and destructive confirmations. */
export function Dialog({
  open,
  title,
  description,
  children,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: DialogProps) {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-mask" role="presentation" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-body">
          <h2 className="modal-title">{title}</h2>
          {description ? <span className="muted">{description}</span> : null}
          {children}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? '提交中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
