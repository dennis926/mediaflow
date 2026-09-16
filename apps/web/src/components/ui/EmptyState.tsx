'use client';

import type { ReactNode } from 'react';
import styles from './ui.module.css';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      {icon ? <span className={styles.emptyIcon}>{icon}</span> : null}
      <span className={styles.emptyTitle}>{title}</span>
      {description ? <span className={styles.emptyText}>{description}</span> : null}
      {action}
    </div>
  );
}
