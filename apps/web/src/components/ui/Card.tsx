'use client';

import type { ReactNode } from 'react';
import styles from './ui.module.css';
import { cn } from './utils';

export interface CardProps {
  title?: ReactNode;
  extra?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function Card({ title, extra, footer, flush = false, className, children }: CardProps) {
  return (
    <section className={cn(styles.card, className)}>
      {title || extra ? (
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>{title}</h2>
          {extra}
        </header>
      ) : null}
      <div className={cn(styles.cardBody, flush && styles.cardBodyFlush)}>{children}</div>
      {footer ? <footer className={styles.cardFooter}>{footer}</footer> : null}
    </section>
  );
}
