import type { ApiResponse } from '@mediaflow/shared';

/** 令牌存储键：与 PC 端完全一致，方便两端口径统一与排查（任务 6b）。 */
export const TOKEN_STORAGE_KEY = 'mediaflow.token';
export const REFRESH_STORAGE_KEY = 'mediaflow.refreshToken';

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
  /** 内部使用：401 续期后重放请求时置位，避免无限循环 */
  retried?: boolean;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_STORAGE_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** 登录/续期成功后一次性写入两个令牌（与 PC 端一致）。 */
export function setSession(accessToken: string | null, refreshToken?: string | null): void {
  if (typeof window === 'undefined') return;
  setToken(accessToken);
  if (refreshToken) window.localStorage.setItem(REFRESH_STORAGE_KEY, refreshToken);
  else if (refreshToken === null) window.localStorage.removeItem(REFRESH_STORAGE_KEY);
}

/** 清除全部本地登录态（退出、或续期失败时调用）。 */
export function clearSession(): void {
  setToken(null);
  if (typeof window !== 'undefined') window.localStorage.removeItem(REFRESH_STORAGE_KEY);
}

function loginUrl(): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return `${base.replace(/\/$/, '')}/login`.replace('//login', '/login');
}

/**
 * 用刷新令牌续期：每次成功都会拿到**新的**刷新令牌（服务端一次性轮换），
 * 因此必须把新的 refreshToken 覆盖写回本地，否则下一次续期会因为旧令牌已被作废而失败（任务 6b）。
 */
export async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as ApiResponse<{ accessToken: string; refreshToken: string }>;
    if (!payload?.data?.accessToken) return false;
    setSession(payload.data.accessToken, payload.data.refreshToken ?? null);
    return true;
  } catch {
    return false;
  }
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

/** Single entry point for every mobile -> API call. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(buildUrl(`/api${path}`, options.query), {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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
    // 与 PC 端一致：先用刷新令牌续期并重放一次，失败才清本地并跳登录
    if (!options.retried && (await refreshSession())) {
      return apiRequest<T>(path, { ...options, retried: true });
    }
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/login')) {
      window.location.href = loginUrl();
    }
    throw new ApiError(payload?.code ?? 40100, payload?.message ?? '登录状态已失效', response.status);
  }

  if (!response.ok || (payload && payload.code !== 0)) {
    throw new ApiError(
      payload?.code ?? response.status,
      payload?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }

  return (payload?.data ?? null) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => apiRequest<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
};
