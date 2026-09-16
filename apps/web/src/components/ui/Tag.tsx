'use client';

import type { ReactNode } from 'react';
import styles from './ui.module.css';
import { cn } from './utils';

export type TagTone = 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASS: Record<TagTone, string> = {
  default: styles.tagDefault,
  brand: styles.tagBrand,
  success: styles.tagSuccess,
  warning: styles.tagWarning,
  danger: styles.tagDanger,
  info: styles.tagInfo,
};

export function Tag({ tone = 'default', children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={cn(styles.tag, TONE_CLASS[tone])}>{children}</span>;
}
