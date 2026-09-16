'use client';

import type { ReactNode } from 'react';
import styles from './ui.module.css';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}

export function StatCard({ label, value, hint, icon }: StatCardProps) {
  return (
    <article className={styles.statCard}>
      <div className={styles.statTop}>
        <span className={styles.statLabel}>{label}</span>
        {icon ? <span className={styles.statIcon}>{icon}</span> : null}
      </div>
      <strong className={styles.statValue}>{value}</strong>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </article>
  );
}
