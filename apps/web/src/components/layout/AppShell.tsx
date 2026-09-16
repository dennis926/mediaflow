'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { authApi } from '../../lib/api/endpoints';
import { getToken, setToken } from '../../lib/api/client';
import {
  AccountIcon,
  AnalyticsIcon,
  ContentIcon,
  DashboardIcon,
  LogoutIcon,
  MenuIcon,
  PublishIcon,
  SettingsIcon,
} from '../../lib/icons';
import { Sidebar, type SidebarItem } from '../ui/Sidebar';
import { Button } from '../ui/Button';
import styles from './AppShell.module.css';

const NAV_ITEMS: SidebarItem[] = [
  { href: '/dashboard', label: '工作台', icon: <DashboardIcon /> },
  { href: '/content', label: '内容中心', icon: <ContentIcon /> },
  { href: '/publish', label: '发布中心', icon: <PublishIcon />, disabled: true },
  { href: '/analytics', label: '数据中心', icon: <AnalyticsIcon />, disabled: true },
  { href: '/accounts', label: '账号管理', icon: <AccountIcon />, disabled: true },
  { href: '/settings', label: '系统设置', icon: <SettingsIcon />, disabled: true },
];

const PAGE_META: Array<{ prefix: string; title: string; subtitle: string }> = [
  { prefix: '/dashboard', title: '工作台', subtitle: '内容与发布整体概况' },
  { prefix: '/content/edit', title: '内容编辑器', subtitle: '编辑正文并生成多平台版本' },
  { prefix: '/content', title: '内容中心', subtitle: '管理全部内容与平台版本' },
];

function resolveMeta(pathname: string): { title: string; subtitle: string } {
  const match = PAGE_META.find((item) => pathname.startsWith(item.prefix));
  return match ? { title: match.title, subtitle: match.subtitle } : { title: 'MediaFlow', subtitle: '' };
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const meta = resolveMeta(pathname);

  useEffect(() => {
    if (!getToken()) router.replace('/login');
    else setReady(true);
  }, [router]);

  const { data: user } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => authApi.me(),
    enabled: ready,
  });

  const signOut = (): void => {
    setToken(null);
    router.replace('/login');
  };

  if (!ready) return null;

  return (
    <div className={styles.shell}>
      <div className={styles.sidebarWrap}>
        <Sidebar
          items={NAV_ITEMS}
          activeHref={pathname}
          footer={<span>香港节点 · v0.1.0</span>}
        />
      </div>

      {drawerOpen ? (
        <>
          <div className={styles.drawerOverlay} onClick={() => setDrawerOpen(false)} role="presentation" />
          <div className={styles.drawer}>
            <Sidebar items={NAV_ITEMS} activeHref={pathname} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </>
      ) : null}

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button type="button" className={styles.menuButton} onClick={() => setDrawerOpen(true)} aria-label="打开导航">
            <MenuIcon />
          </button>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>{meta.title}</h1>
            {meta.subtitle ? <span className={styles.subtitle}>{meta.subtitle}</span> : null}
          </div>
          <div className={styles.actions}>
            <span className={styles.userChip}>
              <span className={styles.userMeta}>
                <span className={styles.userName}>{user?.displayName ?? '未登录'}</span>
                <span className={styles.userRole}>{user?.roles?.join(' / ') ?? '—'}</span>
              </span>
              <span className={styles.avatar}>{(user?.displayName ?? 'M').slice(0, 1)}</span>
            </span>
            <Button variant="secondary" size="sm" icon={<LogoutIcon width={16} height={16} />} onClick={signOut}>
              退出
            </Button>
          </div>
        </header>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
