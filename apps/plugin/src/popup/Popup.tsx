'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PlatformCode } from '@mediaflow/shared';
import {
  DEFAULT_API_BASE,
  FALLBACK_SITE_NAME,
  FALLBACK_SITE_TAGLINE,
  api,
  loadConfig,
  loadSiteBranding,
  platformName,
  saveConfig,
  type PluginAccount,
  type PluginTask,
} from '../lib/api';

const EDITOR_URLS: Record<string, string> = {
  wechat_video: 'https://channels.weixin.qq.com/platform/post/create',
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish',
  zhihu: 'https://zhuanlan.zhihu.com/write',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  baijiahao: 'https://baijiahao.baidu.com/builder/rc/edit?type=news',
};

export function Popup() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userName, setUserName] = useState('');
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  // Branding is fetched from the backend so resellers can rename the product; the
  // fallback keeps the popup renderable while the request is in flight or failing.
  const [siteName, setSiteName] = useState(FALLBACK_SITE_NAME);
  const [siteTagline, setSiteTagline] = useState(FALLBACK_SITE_TAGLINE);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tasks, setTasks] = useState<PluginTask[]>([]);
  const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(async () => {
    const config = await loadConfig();
    setApiBase(config.apiBase);
    // Branding comes from the public endpoint; it never throws, so it cannot break the popup.
    const branding = await loadSiteBranding();
    setSiteName(branding.name);
    setSiteTagline(branding.tagline);
    setLoggedIn(Boolean(config.token));
    if (!config.token) {
      setTasks([]);
      setAccounts([]);
      return;
    }
    try {
      const [me, page, accountList] = await Promise.all([api.me(), api.pluginTasks(), api.accounts()]);
      setUserName(`${me.displayName}（${me.email}）`);
      setTasks(page.items);
      setAccounts(accountList);
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '加载失败' });
      if (error instanceof Error && error.message.includes('登录')) {
        setLoggedIn(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the popup document title in sync with the configured site name.
  useEffect(() => {
    document.title = siteName;
  }, [siteName]);

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await saveConfig({ apiBase });
      const result = await api.login(email.trim(), password);
      setMessage({ tone: 'info', text: `已登录：${result.name}` });
      await refresh();
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '登录失败' });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    await saveConfig({ token: '' });
    setLoggedIn(false);
    setUserName('');
    await refresh();
  };

  /** Opens the platform editor and fills it through the content script. */
  const prepare = async (task: PluginTask): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const target = EDITOR_URLS[task.platform];
      if (!target) {
        setMessage({ tone: 'danger', text: `${platformName(task.platform as PlatformCode)} 暂不支持插件填充` });
        return;
      }
      const tab = await chrome.tabs.create({ url: target, active: true });
      const payload = {
        title: task.contentVariant?.title ?? task.content?.title ?? '',
        body: task.contentVariant?.body ?? '',
        tags: task.contentVariant?.tags ?? [],
      };
      // Give the editor time to boot before injecting the content.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const response = (await chrome.tabs
        .sendMessage(tab.id as number, { type: 'mediaflow:fill', payload })
        .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : '页面未响应' }))) as {
        ok?: boolean;
        error?: string;
        report?: { filled: string[]; missing: string[] };
      };
      if (response?.ok) {
        const missing = response.report?.missing ?? [];
        setMessage({
          tone: missing.length > 0 ? 'danger' : 'info',
          text: missing.length > 0 ? `已填充，但未找到字段：${missing.join('、')}，请手动补充后点击发布` : '内容已填充，请在页面确认后手动点击发布',
        });
      } else {
        setMessage({ tone: 'danger', text: response?.error ?? '填充失败，请确认已打开对应的平台编辑器' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <span className="mark">{siteName.slice(0, 1) || 'M'}</span>
        <span className="headerText">
          <strong>{siteName}</strong>
          <small>{siteTagline}</small>
        </span>
      </header>

      <div className="body">
        {message ? <div className={`banner ${message.tone === 'danger' ? 'bannerDanger' : 'bannerInfo'}`}>{message.text}</div> : null}

        {!loggedIn ? (
          <div className="card">
            <span className="muted">登录 {siteName} 后即可拉取待发布任务</span>
            <div className="field">
              <span className="muted">服务地址</span>
              <input value={apiBase} onChange={(event) => setApiBase(event.target.value)} />
            </div>
            <div className="field">
              <span className="muted">邮箱</span>
              <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" />
            </div>
            <div className="field">
              <span className="muted">密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
              />
            </div>
            <button className="primary block" disabled={busy || !email || !password} onClick={() => void signIn()}>
              {busy ? '登录中…' : '登录'}
            </button>
          </div>
        ) : (
          <>
            <div className="card">
              <div className="row">
                <span>
                  <span className="tag tagOk">已登录</span>
                </span>
                <button onClick={() => void refresh()} disabled={busy}>
                  刷新
                </button>
              </div>
              <span className="muted">{userName}</span>
              <div className="row">
                <span className="muted">已绑定账号 {accounts.length} 个</span>
                <button onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? '收起' : '设置'}</button>
              </div>
              {settingsOpen ? (
                <>
                  <div className="field">
                    <span className="muted">服务地址</span>
                    <input value={apiBase} onChange={(event) => setApiBase(event.target.value)} />
                  </div>
                  <button
                    onClick={() => {
                      void saveConfig({ apiBase }).then(() => refresh());
                    }}
                  >
                    保存地址
                  </button>
                  <button onClick={() => void signOut()}>退出登录</button>
                </>
              ) : null}
            </div>

            <div className="card">
              <strong>待发布任务（{tasks.length}）</strong>
              {tasks.length === 0 ? (
                <span className="muted">暂无插件待发布任务</span>
              ) : (
                tasks.map((task) => (
                  <div className="task" key={task.id}>
                    <span className="taskTitle">{task.contentVariant?.title ?? task.content?.title ?? task.id.slice(0, 8)}</span>
                    <span className="muted">
                      {platformName(task.platform as PlatformCode)} · {task.status}
                    </span>
                    <button disabled={busy} onClick={() => void prepare(task)}>
                      打开平台编辑器并填充
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <strong>已绑定账号</strong>
              {accounts.length === 0 ? (
                <span className="muted">还没有绑定平台账号</span>
              ) : (
                accounts.map((account) => (
                  <div className="row" key={account.id}>
                    <span>{account.accountName}</span>
                    <span className={`tag ${account.hasToken ? 'tagOk' : 'tagWarn'}`}>
                      {account.platformName}
                      {account.hasToken ? '' : ' · 未配置令牌'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <footer className="footer">
        <span>仅填充，不自动发布</span>
        <span>v0.1.0</span>
      </footer>
    </div>
  );
}
