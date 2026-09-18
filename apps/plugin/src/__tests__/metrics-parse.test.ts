import { describe, expect, it } from 'vitest';
import { isMetricsDataPage, parseMetrics, parseMetricsForUrl, platformForUrl, toPlatformCode } from '../content/metrics/parsers';
import {
  BAIJIAHAO_CONTENT_PAGE,
  BAIJIAHAO_DATA_URL,
  DOUYIN_DATA_PAGE,
  DOUYIN_DATA_URL,
  EMPTY_EDITOR_PAGE,
  TOUTIAO_DATA_PAGE,
  TOUTIAO_DATA_URL,
  TRUNCATED_STATE_PAGE,
  UNRELATED_PAGE,
  WECHAT_MP_ARTICLE_PAGE,
  WECHAT_MP_DATA_URL,
  WECHAT_VIDEO_DATA_URL,
  WECHAT_VIDEO_STATS_PAGE,
  XIAOHONGSHU_DATA_URL,
  XIAOHONGSHU_NOTE_MANAGER_PAGE,
  XIAOHONGSHU_TWO_NOTES_PAGE,
  ZHIHU_ANALYSIS_PAGE,
  ZHIHU_DATA_URL,
} from './fixtures/creator-pages';

describe('platform detection', () => {
  it('maps creator hosts to platform codes', () => {
    expect(platformForUrl(DOUYIN_DATA_URL)).toBe('douyin');
    expect(platformForUrl(XIAOHONGSHU_DATA_URL)).toBe('xiaohongshu');
    expect(platformForUrl(WECHAT_VIDEO_DATA_URL)).toBe('wechat_video');
    expect(platformForUrl(WECHAT_MP_DATA_URL)).toBe('wechat_mp');
    expect(platformForUrl(ZHIHU_DATA_URL)).toBe('zhihu');
    expect(platformForUrl(TOUTIAO_DATA_URL)).toBe('toutiao');
    expect(platformForUrl(BAIJIAHAO_DATA_URL)).toBe('baijiahao');
    expect(platformForUrl('https://weibo.com/u/1')).toBeNull();
    expect(platformForUrl('not a url')).toBeNull();
  });

  it('separates data pages from authoring pages', () => {
    expect(isMetricsDataPage(XIAOHONGSHU_DATA_URL)).toBe(true);
    expect(isMetricsDataPage('https://creator.xiaohongshu.com/publish/publish')).toBe(false);
    expect(isMetricsDataPage(DOUYIN_DATA_URL)).toBe(true);
    expect(isMetricsDataPage('https://channels.weixin.qq.com/platform/post/create')).toBe(false);
    expect(isMetricsDataPage('https://channels.weixin.qq.com/platform/post/list')).toBe(true);
    expect(isMetricsDataPage('https://zhuanlan.zhihu.com/write')).toBe(false);
    expect(isMetricsDataPage('https://baijiahao.baidu.com/builder/rc/edit?type=news')).toBe(false);
    expect(isMetricsDataPage('https://weibo.com/upload')).toBe(false);
  });

  it('keeps the local platform names in sync with the shared enum', () => {
    expect(toPlatformCode('wechat_video')).toBe('wechat_video');
    expect(toPlatformCode('douyin')).toBe('douyin');
  });
});

describe('douyin (embedded window._ROUTER_DATA)', () => {
  it('reads every counter, the title and the post id', () => {
    expect(parseMetricsForUrl(DOUYIN_DATA_URL, { html: DOUYIN_DATA_PAGE })).toEqual({
      platform: 'douyin',
      views: 128500,
      likes: 12000,
      comments: 342,
      shares: 88,
      favorites: 1200,
      postId: '7351234567890123456',
      title: '秋季肠道健康指南：3 个饮食搭配',
    });
  });

  it('falls back to the rendered labels when the state is truncated', () => {
    const metrics = parseMetrics('douyin', { html: TRUNCATED_STATE_PAGE, url: DOUYIN_DATA_URL });
    expect(metrics).not.toBeNull();
    // JSON recovery fails on the truncated payload, so views stay unknown instead of guessing.
    expect(metrics?.views).toBeUndefined();
    expect(metrics?.likes).toBe(32000);
    expect(metrics?.comments).toBe(418);
  });
});

describe('xiaohongshu (rendered labels only)', () => {
  it('reads the counters from the DOM text and the id from the URL', () => {
    expect(parseMetricsForUrl(XIAOHONGSHU_DATA_URL, { html: XIAOHONGSHU_NOTE_MANAGER_PAGE })).toEqual({
      platform: 'xiaohongshu',
      views: 12000,
      likes: 1234,
      comments: 56,
      shares: 12,
      favorites: 789,
      postId: '65f0c1a2b3d4e5f60718293a',
    });
  });

  it('uses the text the caller already extracted', () => {
    const text = '观看\n9,876\n点赞\n321\n评论\n12\n收藏\n45\n分享\n6';
    expect(parseMetrics('xiaohongshu', { text, url: 'https://creator.xiaohongshu.com/new/note-manager' })).toEqual({
      platform: 'xiaohongshu',
      views: 9876,
      likes: 321,
      comments: 12,
      shares: 6,
      favorites: 45,
    });
  });

  it('keeps the first matching item on a list page', () => {
    expect(parseMetricsForUrl('https://creator.xiaohongshu.com/new/note-manager', { html: XIAOHONGSHU_TWO_NOTES_PAGE })).toEqual(
      { platform: 'xiaohongshu', views: 11111, likes: 111, postId: 'note-111111', title: '第一篇' },
    );
  });
});

describe('zhihu (script#js-initialData)', () => {
  it('reads the embedded article statistics', () => {
    expect(parseMetricsForUrl(ZHIHU_DATA_URL, { html: ZHIHU_ANALYSIS_PAGE })).toEqual({
      platform: 'zhihu',
      views: 98234,
      likes: 412,
      comments: 37,
      shares: 18,
      favorites: 96,
      postId: '651234567',
      title: '肠道菌群与膳食纤维',
    });
  });
});

describe('toutiao (var _SSR_HYDRATED_DATA + labels)', () => {
  it('merges the embedded state with the rendered counters', () => {
    expect(parseMetricsForUrl(TOUTIAO_DATA_URL, { html: TOUTIAO_DATA_PAGE })).toEqual({
      platform: 'toutiao',
      views: 156000,
      likes: 2345,
      comments: 87,
      shares: 234,
      favorites: 99,
      postId: '7345678901234567890',
    });
  });
});

describe('baijiahao (labels, zero is a value)', () => {
  it('keeps a real zero and treats the placeholder as absent', () => {
    expect(parseMetricsForUrl(BAIJIAHAO_DATA_URL, { html: BAIJIAHAO_CONTENT_PAGE })).toEqual({
      platform: 'baijiahao',
      views: 3456,
      likes: 0,
      shares: 4,
      favorites: 9,
    });
  });
});

describe('wechat_video and wechat_mp', () => {
  it('reads the video channel post list', () => {
    expect(parseMetricsForUrl(WECHAT_VIDEO_DATA_URL, { html: WECHAT_VIDEO_STATS_PAGE })).toEqual({
      platform: 'wechat_video',
      views: 45210,
      likes: 15000,
      comments: 120,
      shares: 64,
      favorites: 310,
      postId: 'export/UzFfBgAAxL',
      title: '三分钟看懂膳食纤维',
    });
  });

  it('reads the official account counters, including 在看 as favorites', () => {
    expect(parseMetricsForUrl(WECHAT_MP_DATA_URL, { html: WECHAT_MP_ARTICLE_PAGE })).toEqual({
      platform: 'wechat_mp',
      views: 12000,
      likes: 210,
      comments: 14,
      shares: 45,
      favorites: 88,
    });
  });
});

describe('unreadable pages', () => {
  const pages: Array<[string, string, string]> = [
    ['douyin', DOUYIN_DATA_URL, UNRELATED_PAGE],
    ['xiaohongshu', XIAOHONGSHU_DATA_URL, UNRELATED_PAGE],
    ['zhihu', ZHIHU_DATA_URL, UNRELATED_PAGE],
    ['toutiao', TOUTIAO_DATA_URL, UNRELATED_PAGE],
  ];

  it.each(pages)('returns null on an unrelated page (%s)', (platform, url, html) => {
    expect(parseMetricsForUrl(url, { html })).toBeNull();
    expect(parseMetrics(platform, { html })).toBeNull();
  });

  it('returns null for an editor page that has state but no counters', () => {
    expect(parseMetricsForUrl(XIAOHONGSHU_DATA_URL, { html: EMPTY_EDITOR_PAGE })).toBeNull();
    expect(parseMetrics('xiaohongshu', { html: EMPTY_EDITOR_PAGE })).toBeNull();
  });

  it('returns null for empty input and unknown platforms', () => {
    expect(parseMetrics('xiaohongshu', {})).toBeNull();
    expect(parseMetrics('xiaohongshu', { html: '', text: '   ' })).toBeNull();
    expect(parseMetrics('wechat_video', { html: EMPTY_EDITOR_PAGE })).toBeNull();
    expect(parseMetrics('weibo', { html: DOUYIN_DATA_PAGE })).toBeNull();
    expect(parseMetricsForUrl('https://weibo.com/u/1', { html: DOUYIN_DATA_PAGE })).toBeNull();
  });

  it('never throws on hostile input', () => {
    const hostile = [
      '<script>window.__INITIAL_STATE__ = {</script>',
      '<script>window.__INITIAL_STATE__ = "not an object"</script>',
      '<script type="application/json">{oops</script>',
      '<script>window.__INITIAL_STATE__ = {"playCount": {"nested": "-"}}</script>',
      '<div>点赞<span></div>',
      '\u0000\u0000',
    ];
    for (const html of hostile) {
      expect(() => parseMetrics('douyin', { html })).not.toThrow();
      expect(parseMetrics('douyin', { html })).toBeNull();
    }
  });
});
