import { describe, expect, it, vi } from 'vitest';
import { PlatformCode } from '@mediaflow/shared';
import { DouyinAdapter } from '../adapters/douyin.adapter';
import { PluginFillAdapter } from '../adapters/plugin-fill.adapter';
import { WechatMpAdapter } from '../adapters/wechat-mp.adapter';
import { createDefaultRegistry } from '../registry';
import { AdapterCredentials, PublishPayload, TokenStore } from '../types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

class InMemoryTokenStore implements TokenStore {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const payload: PublishPayload = {
  taskId: 'task-1',
  title: '测试标题',
  body: '测试正文',
  tags: ['标签'],
  mediaUrls: [],
  aiGenerated: false,
};

const credentials: AdapterCredentials = { appId: 'app-id', appSecret: 'app-secret' };

describe('WechatMpAdapter', () => {
  it('never publishes through the API and returns manual_required', async () => {
    const adapter = new WechatMpAdapter();
    const result = await adapter.publish(payload, credentials);
    expect(result.status).toBe('manual_required');
    expect(result.message).toContain('公众号禁止 API 自动发布');
    expect(adapter.capabilities.canPublish).toBe(false);
  });

  it('caches the app token so the platform is called once', async () => {
    const store = new InMemoryTokenStore();
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'token-abc', expires_in: 7200 }));
    const adapter = new WechatMpAdapter({ fetchImpl, tokenStore: store });

    const first = await adapter.refreshToken(credentials);
    const second = await adapter.refreshToken(credentials);

    expect(first.accessToken).toBe('token-abc');
    expect(second.accessToken).toBe('token-abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps datacube metrics into the analytics snapshot', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        list: [
          {
            msgid: 1001,
            int_page_read_count: 321,
            share_count: 12,
            add_to_fav_count: 7,
            like_num: 5,
            comment_count: 3,
          },
        ],
      }),
    );
    const adapter = new WechatMpAdapter({ fetchImpl, now: () => new Date('2026-09-16T00:00:00Z') });
    const snapshot = await adapter.fetchAnalytics('1001', { ...credentials, accessToken: 'token-abc' });

    expect(snapshot.platform).toBe(PlatformCode.WechatMp);
    expect(snapshot.metrics).toEqual({ views: 321, likes: 5, comments: 3, shares: 12, favorites: 7 });
  });
});

describe('DouyinAdapter', () => {
  it('fails with a clear message when the account is not bound', async () => {
    const adapter = new DouyinAdapter();
    const result = await adapter.publish(payload, credentials);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('未绑定抖音账号');
  });

  it('uploads then creates the item when a token is present', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.includes('/video/upload/')) return jsonResponse({ data: { video: { video_id: 'video-1' } } });
      return jsonResponse({ data: { item_id: 'item-9' } });
    });
    const adapter = new DouyinAdapter({ fetchImpl });
    const result = await adapter.publish(
      { ...payload, mediaUrls: ['https://cdn.example.com/a.mp4'] },
      { ...credentials, accessToken: 't', openId: 'open-1' },
    );

    expect(result.status).toBe('published');
    expect(result.platformPostId).toBe('item-9');
    expect(result.platformUrl).toBe('https://www.douyin.com/video/item-9');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports an interaction-free capability set', () => {
    expect(new DouyinAdapter().capabilities.canInteract).toBe(false);
  });
});

describe('PluginFillAdapter', () => {
  it('waits for a human to press publish', async () => {
    const adapter = new PluginFillAdapter(PlatformCode.Zhihu, 'https://zhuanlan.zhihu.com/write');
    const result = await adapter.publish(payload, credentials);
    expect(result.status).toBe('pending');
    expect(result.message).toContain('手动点击发布');
  });
});

describe('createDefaultRegistry', () => {
  it('registers every platform from the seed data', () => {
    const registry = createDefaultRegistry();
    expect(registry.list()).toHaveLength(7);
    for (const platform of Object.values(PlatformCode)) {
      expect(registry.has(platform)).toBe(true);
    }
  });
});
