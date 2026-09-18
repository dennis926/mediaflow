import type { PlatformCode } from '@mediaflow/shared';

export interface PluginConfig {
  apiBase: string;
  token: string;
}

export interface PluginTask {
  id: string;
  platform: PlatformCode;
  status: string;
  contentId: string;
  content?: { id: string; title: string };
  contentVariant?: { title: string; body: string; tags: string[] } | null;
}

export interface PluginAccount {
  id: string;
  platform: PlatformCode;
  platformName: string;
  accountName: string;
  hasToken: boolean;
}

export const DEFAULT_API_BASE = 'https://auto.liangyijianye.cn';

/** Shown while the public endpoint is unreachable, so the popup always has something to render. */
export const FALLBACK_SITE_NAME = 'MediaFlow';
export const FALLBACK_SITE_TAGLINE = '自动填充 · 人工发布';

/** Public site metadata served by `GET /api/public/site-config`; needs no token. */
export interface SiteConfigView {
  name: string;
  tagline: string;
  company: string;
  supportEmail: string;
  pageSize: number;
  aiDisclosureSuffix: string;
}

/** Branding the popup renders, already reduced to non-empty strings. */
export interface SiteBranding {
  name: string;
  tagline: string;
}

/** Body of `POST /api/analytics/plugin-metrics` (see apps/api analytics plugin-metrics.dto.ts). */
export interface PluginMetricsPayload {
  platform: PlatformCode;
  socialAccountId?: string;
  contentId?: string;
  postId?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  favorites?: number;
}

const CONFIG_KEY = 'mediaflow.config';

export async function loadConfig(): Promise<PluginConfig> {
  const stored = await chrome.storage.local.get([CONFIG_KEY, 'token']);
  const config = (stored[CONFIG_KEY] ?? {}) as Partial<PluginConfig>;
  return {
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    token: config.token ?? (typeof stored.token === 'string' ? stored.token : ''),
  };
}

export async function saveConfig(patch: Partial<PluginConfig>): Promise<PluginConfig> {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [CONFIG_KEY]: next, token: next.token });
  return next;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = await loadConfig();
  const response = await fetch(`${config.apiBase}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
  if (!response.ok || (payload && payload.code !== 0)) {
    throw new Error(payload?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return (payload?.data ?? null) as T;
}

export const api = {
  /** Public branding/tagline: readable before login, used to label the popup. */
  siteConfig: () => request<SiteConfigView | null>('/public/site-config'),
  login: async (email: string, password: string): Promise<{ token: string; name: string }> => {
    const result = await request<{ accessToken: string; user: { displayName: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    await saveConfig({ token: result.accessToken });
    return { token: result.accessToken, name: result.user.displayName };
  },
  me: () => request<{ displayName: string; email: string }>('/auth/me'),
  /** Tasks awaiting browser-extension assisted publishing. */
  pluginTasks: () => request<{ items: PluginTask[] }>('/publish/tasks?pageSize=20&status=pending'),
  accounts: () => request<PluginAccount[]>('/accounts'),
  /** Confirms a human-driven publish and optionally reports the platform post id. */
  confirm: (taskId: string, platformUrl?: string) =>
    request<{ id: string }>(`/publish/tasks/${taskId}/retry`, { method: 'POST' }).then(() => ({ id: taskId, platformUrl })),
  /** Pushes numbers scraped from a platform analytics page. */
  reportMetrics: (payload: PluginMetricsPayload) =>
    request<{ id: string }>('/analytics/plugin-metrics', { method: 'POST', body: JSON.stringify(payload) }),
};

/**
 * Loads the site branding shown in the popup.
 * Never throws: a failed or malformed response falls back to the built-in brand so the
 * popup keeps rendering instead of showing an error or a blank page.
 */
export async function loadSiteBranding(): Promise<SiteBranding> {
  try {
    const config = await api.siteConfig();
    const name = typeof config?.name === 'string' && config.name.trim().length > 0 ? config.name.trim() : FALLBACK_SITE_NAME;
    const tagline =
      typeof config?.tagline === 'string' && config.tagline.trim().length > 0 ? config.tagline.trim() : FALLBACK_SITE_TAGLINE;
    return { name, tagline };
  } catch {
    return { name: FALLBACK_SITE_NAME, tagline: FALLBACK_SITE_TAGLINE };
  }
}

export function platformName(platform: PlatformCode): string {
  const labels: Record<string, string> = {
    wechat_mp: '微信公众号',
    wechat_video: '视频号',
    douyin: '抖音',
    xiaohongshu: '小红书',
    zhihu: '知乎',
    toutiao: '今日头条',
    baijiahao: '百家号',
  };
  return labels[platform] ?? platform;
}
