import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  REFRESH_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  apiRequest,
  clearSession,
  getRefreshToken,
  getToken,
  refreshSession,
  setSession,
} from '../client';

/** 依次返回给定的响应（未列出的调用返回 500，方便暴露意外请求）。 */
function mockFetchSequence(responses: Array<{ status: number; body?: unknown }>): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => {
    const next = queue.shift() ?? { status: 500, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body ?? {}),
      json: async () => next.body ?? {},
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/login'); // 避免 401 分支触发 jsdom 不支持的跳转
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('H5 会话存储（任务 6b）', () => {
  it('登录后同时保存 accessToken 与 refreshToken（与 PC 端同 key）', () => {
    setSession('access-1', 'refresh-1');

    expect(getToken()).toBe('access-1');
    expect(getRefreshToken()).toBe('refresh-1');
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('access-1');
    expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBe('refresh-1');
  });

  it('clearSession 清掉两个令牌与其余会话痕迹', () => {
    setSession('access-1', 'refresh-1');
    clearSession();

    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(window.localStorage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
  });

  it('没有 refreshToken 时不去请求续期', async () => {
    const fetchMock = mockFetchSequence([]);
    await expect(refreshSession()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('续期成功后写回**新的**刷新令牌（服务端一次性轮换）', async () => {
    setSession('access-old', 'refresh-old');
    const fetchMock = mockFetchSequence([
      { status: 201, body: { code: 0, data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } },
    ]);

    await expect(refreshSession()).resolves.toBe(true);

    expect(getToken()).toBe('access-new');
    expect(getRefreshToken()).toBe('refresh-new');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { refreshToken: string };
    expect(body.refreshToken).toBe('refresh-old');
  });

  it('续期失败（401）时返回 false，不覆盖本地令牌', async () => {
    setSession('access-old', 'refresh-old');
    mockFetchSequence([{ status: 401, body: { code: 40100, message: '已登出' } }]);

    await expect(refreshSession()).resolves.toBe(false);
    expect(getToken()).toBe('access-old');
    expect(getRefreshToken()).toBe('refresh-old');
  });
});

describe('H5 请求 401 处理（任务 6b）', () => {
  it('401 后自动续期并重放请求（成功返回业务数据）', async () => {
    setSession('access-old', 'refresh-old');
    const fetchMock = mockFetchSequence([
      { status: 401, body: { code: 40100, message: '过期' } },                                     // 首次请求
      { status: 201, body: { code: 0, data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } }, // 续期
      { status: 200, body: { code: 0, data: { items: ['ok'] } } },                                  // 重放
    ]);

    await expect(apiRequest<{ items: string[] }>('/contents')).resolves.toEqual({ items: ['ok'] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const replayHeaders = (fetchMock.mock.calls[2][1] as { headers: Record<string, string> }).headers;
    expect(replayHeaders.Authorization).toBe('Bearer access-new'); // 重放用的是新访问令牌
    expect(getRefreshToken()).toBe('refresh-new');
  });

  it('续期失败：清空本地登录态并抛出 ApiError', async () => {
    setSession('access-old', 'refresh-old');
    mockFetchSequence([
      { status: 401, body: { code: 40100, message: '过期' } },
      { status: 401, body: { code: 40100, message: '令牌已被轮换' } },
    ]);

    await expect(apiRequest('/contents')).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('重放后仍 401 时不再续期（避免无限循环）', async () => {
    setSession('access-old', 'refresh-old');
    const fetchMock = mockFetchSequence([
      { status: 401, body: { code: 40100, message: '过期' } },
      { status: 201, body: { code: 0, data: { accessToken: 'access-new', refreshToken: 'refresh-new' } } },
      { status: 401, body: { code: 40100, message: '仍然过期' } },
    ]);

    await expect(apiRequest('/contents')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 首次 + 续期 + 重放一次，没有第三次请求
    expect(getRefreshToken()).toBeNull();
  });

  it('非 401 错误不做续期（直接抛出）', async () => {
    setSession('access-1', 'refresh-1');
    const fetchMock = mockFetchSequence([{ status: 403, body: { code: 40300, message: '无权访问' } }]);

    await expect(apiRequest('/settings')).rejects.toThrow('无权访问');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe('access-1');
  });
});
