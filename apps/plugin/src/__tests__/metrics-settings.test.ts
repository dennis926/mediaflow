import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_METRICS_INTERVAL_MINUTES,
  MAX_METRICS_INTERVAL_MINUTES,
  MAX_METRICS_TARGETS,
  METRICS_INTERVAL_KEY,
  METRICS_TARGETS_KEY,
  loadMetricsSettings,
  normalizeMetricsSettings,
  parseTargetLines,
  saveMetricsSettings,
  targetKey,
} from '../lib/metrics-settings';

const CONTENT_ID = '3f8b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ACCOUNT_ID = '7a1b2c3d-4e5f-4a6b-9c8d-1e2f3a4b5c6d';

/** Minimal chrome.storage.local stub, mirroring the one in branding.test.ts. */
function chromeStub(initial: Record<string, unknown> = {}): { storage: { local: { get: unknown; set: unknown } } } {
  const store: Record<string, unknown> = { ...initial };
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const result: Record<string, unknown> = {};
          for (const key of keys) if (key in store) result[key] = store[key];
          return result;
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        }),
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeMetricsSettings', () => {
  it('falls back to the original three-hour period and no targets', () => {
    expect(normalizeMetricsSettings({})).toEqual({ intervalMinutes: DEFAULT_METRICS_INTERVAL_MINUTES, targets: [] });
    expect(DEFAULT_METRICS_INTERVAL_MINUTES).toBe(180);
    expect(normalizeMetricsSettings({ [METRICS_INTERVAL_KEY]: 'soon', [METRICS_TARGETS_KEY]: 'nope' })).toEqual({
      intervalMinutes: DEFAULT_METRICS_INTERVAL_MINUTES,
      targets: [],
    });
  });

  it('clamps the interval into a range the alarms API accepts', () => {
    expect(normalizeMetricsSettings({ [METRICS_INTERVAL_KEY]: '30' }).intervalMinutes).toBe(30);
    expect(normalizeMetricsSettings({ [METRICS_INTERVAL_KEY]: 2.6 }).intervalMinutes).toBe(3);
    // Below one minute Chrome ignores the period, so the floor wins.
    expect(normalizeMetricsSettings({ [METRICS_INTERVAL_KEY]: 0.4 }).intervalMinutes).toBe(1);
    expect(normalizeMetricsSettings({ [METRICS_INTERVAL_KEY]: 0 }).intervalMinutes).toBe(DEFAULT_METRICS_INTERVAL_MINUTES);
    expect(normalizeMetricsSettings({ [METRICS_INTERVAL_KEY]: -5 }).intervalMinutes).toBe(DEFAULT_METRICS_INTERVAL_MINUTES);
    expect(normalizeMetricsSettings({ [METRICS_INTERVAL_KEY]: 99999 }).intervalMinutes).toBe(MAX_METRICS_INTERVAL_MINUTES);
  });

  it('keeps the plain URL array format and drops unusable entries', () => {
    const settings = normalizeMetricsSettings({
      [METRICS_TARGETS_KEY]: [
        'https://creator.xiaohongshu.com/new/note-manager',
        'https://creator.xiaohongshu.com/new/note-manager',
        'chrome://extensions',
        'javascript:alert(1)',
        '',
        42,
        null,
        { url: 'https://channels.weixin.qq.com/platform/post/list' },
      ],
    });
    expect(settings.targets.map((target) => target.url)).toEqual([
      'https://creator.xiaohongshu.com/new/note-manager',
      'https://channels.weixin.qq.com/platform/post/list',
    ]);
  });

  it('keeps UUID v4 ids and drops anything the API would reject', () => {
    const settings = normalizeMetricsSettings({
      [METRICS_TARGETS_KEY]: [
        { url: 'https://mp.toutiao.com/profile_v4/graphic/articles', contentId: CONTENT_ID, socialAccountId: ACCOUNT_ID },
        { url: 'https://zhuanlan.zhihu.com/creator/analysis/articles', contentId: 'not-a-uuid', socialAccountId: '123' },
      ],
    });
    expect(settings.targets[0]).toEqual({
      url: 'https://mp.toutiao.com/profile_v4/graphic/articles',
      contentId: CONTENT_ID,
      socialAccountId: ACCOUNT_ID,
    });
    expect(settings.targets[1]).toEqual({ url: 'https://zhuanlan.zhihu.com/creator/analysis/articles' });
  });

  it('caps the target list', () => {
    const urls = Array.from({ length: MAX_METRICS_TARGETS + 10 }, (_value, index) => `https://creator.douyin.com/creator-micro/content/manage?page=${index}`);
    expect(normalizeMetricsSettings({ [METRICS_TARGETS_KEY]: urls }).targets).toHaveLength(MAX_METRICS_TARGETS);
  });
});

describe('targetKey', () => {
  it('ignores the hash and a trailing slash but keeps the query', () => {
    expect(targetKey('https://creator.xiaohongshu.com/new/note-manager#top')).toBe('creator.xiaohongshu.com/new/note-manager');
    expect(targetKey('https://creator.xiaohongshu.com/new/note-manager/')).toBe('creator.xiaohongshu.com/new/note-manager');
    expect(targetKey('https://creator.xiaohongshu.com/new/note-manager?page=2')).toBe('creator.xiaohongshu.com/new/note-manager?page=2');
  });
});

describe('parseTargetLines', () => {
  it('reads one URL per line, ignores blanks and # comments', () => {
    const text = [
      '# 小红书数据页',
      '  https://creator.xiaohongshu.com/new/note-manager  ',
      '',
      'not a url',
      'https://channels.weixin.qq.com/platform/post/list # 视频号',
    ].join('\n');
    expect(parseTargetLines(text).map((target) => target.url)).toEqual([
      'https://creator.xiaohongshu.com/new/note-manager',
      'https://channels.weixin.qq.com/platform/post/list',
    ]);
  });
});

describe('storage round trip', () => {
  it('loads defaults when storage is empty', async () => {
    vi.stubGlobal('chrome', chromeStub());
    await expect(loadMetricsSettings()).resolves.toEqual({ intervalMinutes: DEFAULT_METRICS_INTERVAL_MINUTES, targets: [] });
  });

  it('saves the normalised settings and reads them back', async () => {
    vi.stubGlobal('chrome', chromeStub({ [METRICS_TARGETS_KEY]: 'broken' }));
    const saved = await saveMetricsSettings({
      intervalMinutes: 0.2,
      targets: [
        { url: 'https://mp.toutiao.com/profile_v4/graphic/articles', contentId: CONTENT_ID },
        { url: 'ftp://example.com/nope' },
      ],
    });
    expect(saved.intervalMinutes).toBe(1);
    expect(saved.targets).toEqual([{ url: 'https://mp.toutiao.com/profile_v4/graphic/articles', contentId: CONTENT_ID }]);
    await expect(loadMetricsSettings()).resolves.toEqual(saved);
  });
});
