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
  /**
   * Tasks awaiting browser-extension assisted publishing.
   *
   * 同时取「待发布」与「待人工发布」：插件的核心用途恰恰是处理 `manual_required`
   * （公众号禁止 API 发布、视频号/知乎等靠插件填充 + 人工确认）。
   * 只取 pending 会让这些任务在插件里**根本看不见**（实测发现的断点）。
   */
  pluginTasks: async (): Promise<{ items: PluginTask[] }> => {
    const [pending, manualRequired] = await Promise.all([
      request<{ items: PluginTask[] }>('/publish/tasks?pageSize=20&status=pending'),
      request<{ items: PluginTask[] }>('/publish/tasks?pageSize=20&status=manual_required'),
    ]);
    const seen = new Set<string>();
    const items = [...manualRequired.items, ...pending.items].filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
    return { items };
  },
  accounts: () => request<PluginAccount[]>('/accounts'),
  /**
   * 人工发布完成回填（插件侧）：走正式接口写回状态、链接与审计。
   * 之前这里误用了 `retry` 接口——语义不对，也不会记录链接，任务级数据一直是空的。
   */
  confirm: (taskId: string, platformUrl?: string, postId?: string) =>
    request<{ id: string }>(`/publish/tasks/${taskId}/manual-published`, {
      method: 'POST',
      body: JSON.stringify({ url: platformUrl || undefined, postId: postId || undefined, note: '浏览器插件回填' }),
    }).then((task) => ({ id: (task as { id?: string }).id ?? taskId, platformUrl })),
  /** 人工发布失败回填（原因必填，后端会校验长度） */
  markFailed: (taskId: string, reason: string) =>
    request<{ id: string }>(`/publish/tasks/${taskId}/manual-failed`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
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
