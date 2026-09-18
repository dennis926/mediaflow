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
  /** 站点名称与副标题来自后台配置（设置 → 站点信息） */
  siteName?: string;
  siteTagline?: string;
  /** Logo 图片地址，留空用站点名首字 */
  siteLogoUrl?: string;
  /** 品牌下方的附加区域（例如工作区切换器） */
  brandExtra?: ReactNode;
}

export function Sidebar({ items, activeHref, footer, onNavigate, siteName = 'MediaFlow', siteTagline = '', siteLogoUrl = '', brandExtra }: SidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="主导航">
      <div className={styles.brand}>
        {siteLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.brandLogo} src={siteLogoUrl} alt={siteName} />
        ) : (
          <span className={styles.brandMark}>{siteName.slice(0, 1).toUpperCase()}</span>
        )}
        <span className={styles.brandText}>
          <span className={styles.brandName}>{siteName}</span>
          {siteTagline ? <span className={styles.brandTag}>{siteTagline}</span> : null}
        </span>
      </div>

      {brandExtra}

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
