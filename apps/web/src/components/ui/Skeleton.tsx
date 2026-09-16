'use client';

import styles from './ui.module.css';

export function Skeleton({ height = 'var(--mf-space-5)', width = '100%' }: { height?: string; width?: string }) {
  return <span className={styles.skeleton} style={{ display: 'block', height, width }} aria-hidden />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-3)' }}>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} height="var(--mf-space-6)" />
      ))}
    </div>
  );
}
