'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { authApi } from '../../lib/api/endpoints';
import { getToken, setToken } from '../../lib/api/client';
import { trackEvent } from '../../lib/track';
import { useSiteConfig } from '../../lib/knowledge';
import {
  AccountIcon,
  AnalyticsIcon,
  CalendarIcon,
  ContentIcon,
  KnowledgeIcon,
  ReviewIcon,
  DashboardIcon,
  LogoutIcon,
  MenuIcon,
  PublishIcon,
  WarningIcon,
  SettingsIcon,
  SparkleIcon,
} from '../../lib/icons';
import { NotificationBell } from './NotificationBell';
import { PasswordDialog } from './PasswordDialog';
import { Sidebar, type SidebarItem } from '../ui/Sidebar';
import { Button } from '../ui/Button';
import styles from './AppShell.module.css';

const NAV_ITEMS: SidebarItem[] = [
  { href: '/dashboard', label: '工作台', icon: <DashboardIcon /> },
  { href: '/content', label: '内容中心', icon: <ContentIcon /> },
  { href: '/publish/queue', label: '发布队列', icon: <PublishIcon /> },
  { href: '/publish/calendar', label: '排期日历', icon: <CalendarIcon /> },
  { href: '/reviews', label: '内容审核', icon: <ReviewIcon /> },
  { href: '/media', label: '素材库', icon: <ContentIcon /> },
  { href: '/knowledge', label: '知识库管理', icon: <KnowledgeIcon /> },
  { href: '/analytics', label: '数据中心', icon: <AnalyticsIcon /> },
  { href: '/accounts', label: '账号管理', icon: <AccountIcon /> },
  { href: '/users', label: '用户管理', icon: <AccountIcon /> },
  { href: '/ai-usage', label: 'AI 用量', icon: <SparkleIcon /> },
  { href: '/audit', label: '审计日志', icon: <ReviewIcon /> },
  { href: '/settings', label: '系统设置', icon: <SettingsIcon /> },
];

const PAGE_META: Array<{ prefix: string; title: string; subtitle: string }> = [
  { prefix: '/ai-usage', title: 'AI 用量与花费', subtitle: '调用次数、token 消耗与成本估算' },
  { prefix: '/audit', title: '审计日志', subtitle: '谁在什么时候改了什么' },
  { prefix: '/settings', title: '系统设置', subtitle: 'AI 与平台密钥、发布队列参数' },
  { prefix: '/reviews', title: '内容审核', subtitle: '提交审核与审核决定' },
  { prefix: '/media', title: '素材库', subtitle: '图片与视频素材：上传、分组、复制外链' },
  { prefix: '/knowledge', title: '知识库管理', subtitle: '品牌资料维护 · AI 生成时的引用口径' },
  { prefix: '/users', title: '用户管理', subtitle: '成员、角色与密码管理' },
  { prefix: '/analytics', title: '数据中心', subtitle: '核心指标、趋势与账号排行' },
  { prefix: '/accounts', title: '账号管理', subtitle: '绑定与管理平台账号' },
  { prefix: '/dashboard', title: '工作台', subtitle: '内容与发布整体概况' },
  { prefix: '/content/new', title: '内容编辑器', subtitle: '新建内容并生成多平台版本' },
  { prefix: '/content/', title: '内容编辑器', subtitle: '编辑正文并生成多平台版本' },
  { prefix: '/content', title: '内容中心', subtitle: '管理全部内容与平台版本' },
  { prefix: '/publish/calendar', title: '排期日历', subtitle: '按周查看发布排期' },
  { prefix: '/publish/queue', title: '发布队列', subtitle: '任务状态、失败重试与人工发布' },
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
  const [passwordOpen, setPasswordOpen] = useState(false);
  const meta = resolveMeta(pathname);
  const site = useSiteConfig();

  // 页面访问埋点：数据中心可以看到各功能的使用热度
  useEffect(() => {
    void trackEvent('page_view', { properties: { path: pathname } });
  }, [pathname]);

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
    setToken(null, null);
    router.replace('/login');
  };

  if (!ready) return null;

  return (
    <div className={styles.shell}>
      <div className={styles.sidebarWrap}>
        <Sidebar
          items={NAV_ITEMS}
          activeHref={pathname}
          siteName={site.name}
          siteTagline={site.tagline}
          siteLogoUrl={site.logoUrl}
          footer={<span>香港节点 · v0.1.0</span>}
        />
      </div>

      {drawerOpen ? (
        <>
          <div className={styles.drawerOverlay} onClick={() => setDrawerOpen(false)} role="presentation" />
          <div className={styles.drawer}>
            <Sidebar items={NAV_ITEMS} activeHref={pathname}
          siteName={site.name}
          siteTagline={site.tagline}
          siteLogoUrl={site.logoUrl} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </>
      ) : null}

      {user?.mustChangePassword ? (
        <div className={styles.mustChange}>
          <WarningIcon width={16} height={16} />
          <span>你正在使用管理员分配的临时密码，请立即修改后再继续使用。</span>
          <Button size="sm" onClick={() => setPasswordOpen(true)}>
            立即修改
          </Button>
        </div>
      ) : null}

      <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />

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
            <NotificationBell />
            <span className={styles.userChip}>
              <span className={styles.userMeta}>
                <span className={styles.userName}>{user?.displayName ?? '未登录'}</span>
                <span className={styles.userRole}>{user?.roles?.join(' / ') ?? '—'}</span>
              </span>
              <span className={styles.avatar}>{(user?.displayName ?? 'M').slice(0, 1)}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => setPasswordOpen(true)}>
              修改密码
            </Button>
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
