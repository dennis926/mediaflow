'use client';

import type { ReactNode } from 'react';
import styles from './ui.module.css';
import { cn } from './utils';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<BannerTone, string> = {
  info: styles.bannerInfo,
  success: styles.bannerSuccess,
  warning: styles.bannerWarning,
  danger: styles.bannerDanger,
};

export function Banner({ tone = 'info', children }: { tone?: BannerTone; children: ReactNode }) {
  return <div className={cn(styles.banner, TONE_CLASS[tone])}>{children}</div>;
}
