'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './ui.module.css';
import { cn } from './utils';

export interface SidebarItem {
  href: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
}

export interface SidebarProps {
  items: SidebarItem[];
  activeHref: string;
  footer?: ReactNode;
  onNavigate?: () => void;
}

export function Sidebar({ items, activeHref, footer, onNavigate }: SidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="主导航">
      <div className={styles.brand}>
        <span className={styles.brandMark}>M</span>
        <span className={styles.brandText}>
          <span className={styles.brandName}>MediaFlow</span>
          <span className={styles.brandTag}>内容分发与矩阵运营</span>
        </span>
      </div>

      <div className={styles.nav}>
        <span className={styles.navSection}>运营</span>
        {items.map((item) => {
          const active = activeHref === item.href || activeHref.startsWith(`${item.href}/`);
          if (item.disabled) {
            return (
              <span key={item.href} className={cn(styles.navItem)} style={{ opacity: 0.45, cursor: 'not-allowed' }}>
                <span className={styles.navIcon}>{item.icon}</span>
                {item.label}
              </span>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(styles.navItem, active && styles.navItemActive)}
              aria-current={active ? 'page' : undefined}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </div>

      {footer ? <div className={styles.sidebarFooter}>{footer}</div> : null}
    </nav>
  );
}
