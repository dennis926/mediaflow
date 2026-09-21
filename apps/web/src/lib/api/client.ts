import type { ApiResponse } from '@mediaflow/shared';

export const TOKEN_STORAGE_KEY = 'mediaflow.token';
export const REFRESH_STORAGE_KEY = 'mediaflow.refresh';

export class ApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** 内部使用：续期后只重放一次，避免刷新成功但令牌仍被拒时无限递归 */
  retried?: boolean;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string | null, refreshToken?: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  if (refreshToken === undefined) return;
  if (refreshToken) window.localStorage.setItem(REFRESH_STORAGE_KEY, refreshToken);
  else window.localStorage.removeItem(REFRESH_STORAGE_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_STORAGE_KEY);
}

function clearSession(): void {
  setToken(null, null);
}

/**
 * 用刷新令牌换新的访问令牌；并发请求只发一次刷新（单飞），避免令牌被刷新多次。
 * 免登录时长由后台配置（AUTH_REFRESH_EXPIRES，默认 7 天）。
 */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return Promise.resolve(false);

  refreshInFlight = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
    .then(async (response) => {
      if (!response.ok) return false;
      const payload = (await response.json()) as { data?: { accessToken?: string; refreshToken?: string } };
      const accessToken = payload.data?.accessToken;
      if (!accessToken) return false;
      setToken(accessToken, payload.data?.refreshToken ?? refreshToken);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** Single entry point for every browser -> API call; components must never call fetch directly. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(buildUrl(`/api${path}`, options.query), {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    cache: 'no-store',
  });

  let payload: ApiResponse<T> | null = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as ApiResponse<T>;
    } catch {
      payload = null;
    }
  }

  if (response.status === 401) {
    // 访问令牌过期：先用刷新令牌续期并重放一次请求，失败才跳登录
    if (!options.retried && (await refreshSession())) {
      return apiRequest<T>(path, { ...options, retried: true });
    }
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(payload?.code ?? 40100, payload?.message ?? '登录状态已失效', response.status);
  }

  if (!response.ok || (payload && payload.code !== 0)) {
    throw new ApiError(payload?.code ?? response.status, payload?.message ?? `请求失败（HTTP ${response.status}）`, response.status);
  }

  return (payload?.data ?? null) as T;
}

/** Multipart upload: Content-Type must stay unset so the browser adds the boundary. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await response.text();
  let payload: ApiResponse<T> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as ApiResponse<T>;
    } catch {
      payload = null;
    }
  }
  if (response.status === 401 && !(await refreshSession())) {
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
  if (!response.ok || (payload && payload.code !== 0)) {
    throw new ApiError(payload?.code ?? response.status, payload?.message ?? `上传失败（HTTP ${response.status}）`, response.status);
  }
  return (payload?.data ?? null) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => apiRequest<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, query?: RequestOptions['query']) => apiRequest<T>(path, { method: 'DELETE', query }),
  /** DELETE 也要带请求体时用它（例如删除工作区需要名称二次确认） */
  deleteWithBody: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'DELETE', body }),
};
