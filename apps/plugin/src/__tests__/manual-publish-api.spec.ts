import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';

/**
 * 插件侧"人工发布闭环"的接口行为。
 *
 * 修掉的两个真实断点：
 *   ① `pluginTasks()` 只拉 `status=pending` —— 而插件的主要用途恰恰是处理 `manual_required`
 *      （公众号禁止 API 发布、视频号/知乎等靠插件填充 + 人工确认），这些任务在插件里**根本看不见**；
 *   ② `confirm()` 误用 `retry` 接口 —— 语义不对，也不会记录发布链接与审计，任务级数据一直是空的。
 */

const calls: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(handler: (url: string) => unknown) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: 'ok', data: handler(String(url)) }),
      text: async () => JSON.stringify({ code: 0, message: 'ok', data: handler(String(url)) }),
    } as unknown as Response;
  });
}

/** api.ts 读 token 用 chrome.storage；测试环境需要替身，否则 ReferenceError: chrome is not defined */
function stubChrome() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({ config: { token: 'test-token' } }),
        set: async () => undefined,
      },
    },
  });
}

describe('插件：待发布任务的取值范围', () => {
  beforeEach(() => {
    calls.length = 0;
    stubChrome();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同时拉取「待发布」与「待人工发布」并按 id 去重', async () => {
    mockFetch((url) => {
      if (url.includes('status=manual_required')) {
        return { items: [{ id: 't-manual', status: 'manual_required' }, { id: 't-same' }] };
      }
      return { items: [{ id: 't-pending', status: 'pending' }, { id: 't-same' }] };
    });

    const result = await api.pluginTasks();
    const ids = result.items.map((task) => task.id);

    expect(ids).toContain('t-manual');
    expect(ids).toContain('t-pending');
    // 同一任务只出现一次（否则 popup 会重复显示、用户会重复点）
    expect(ids.filter((id) => id === 't-same')).toHaveLength(1);
    // 并且真的请求了两种状态
    expect(calls.some((call) => call.url.includes('status=manual_required'))).toBe(true);
    expect(calls.some((call) => call.url.includes('status=pending'))).toBe(true);
    // 待人工发布排在前面（插件的核心用途）
    expect(ids[0]).toBe('t-manual');
  });
});

describe('插件：人工发布回填', () => {
  beforeEach(() => {
    calls.length = 0;
    stubChrome();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('confirm 走「标记已发布」接口，并带上链接与备注', async () => {
    mockFetch(() => ({ id: 't-1' }));
    await api.confirm('t-1', 'https://mp.weixin.qq.com/s/abc');

    const call = calls.find((item) => item.url.includes('/publish/tasks/t-1/manual-published'));
    expect(call).toBeTruthy();
    expect(call?.init?.method).toBe('POST');
    const body = JSON.parse(String(call?.init?.body));
    expect(body.url).toBe('https://mp.weixin.qq.com/s/abc');
    expect(body.note).toContain('插件');
    // 不再误用 retry 接口
    expect(calls.some((item) => item.url.includes('/retry'))).toBe(false);
  });

  it('confirm 不传链接时也能回填（后端允许只标记状态）', async () => {
    mockFetch(() => ({ id: 't-2' }));
    await api.confirm('t-2');
    const call = calls.find((item) => item.url.includes('/publish/tasks/t-2/manual-published'));
    const body = JSON.parse(String(call?.init?.body));
    expect(body.url).toBeUndefined();
  });

  it('markFailed 走「标记发布失败」接口并带原因', async () => {
    mockFetch(() => ({ id: 't-3' }));
    await api.markFailed('t-3', '平台提示图片尺寸不合规');
    const call = calls.find((item) => item.url.includes('/publish/tasks/t-3/manual-failed'));
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call?.init?.body))).toEqual({ reason: '平台提示图片尺寸不合规' });
  });
});
