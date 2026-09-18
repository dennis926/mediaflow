import { describe, expect, it } from 'vitest';
import { collectDataPageMetrics, collectMetrics, type PageEnvironment } from '../content/metrics/collect';
import {
  BAIJIAHAO_CONTENT_PAGE,
  BAIJIAHAO_DATA_URL,
  DOUYIN_DATA_PAGE,
  DOUYIN_DATA_URL,
  UNRELATED_PAGE,
  XIAOHONGSHU_DATA_URL,
  XIAOHONGSHU_NOTE_MANAGER_PAGE,
} from './fixtures/creator-pages';

function environment(url: string, html: string, text = ''): PageEnvironment {
  return { url, html, text };
}

describe('collectMetrics', () => {
  it('scrapes a supported data page from HTML alone', () => {
    expect(collectMetrics(environment(DOUYIN_DATA_URL, DOUYIN_DATA_PAGE))).toEqual({
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

  it('prefers the text the caller already extracted', () => {
    const metrics = collectMetrics(environment(XIAOHONGSHU_DATA_URL, '<html></html>', '观看\n2.5万\n点赞\n1,024\n评论\n8\n收藏\n9\n分享\n3'));
    expect(metrics?.views).toBe(25000);
    expect(metrics?.likes).toBe(1024);
    expect(metrics?.comments).toBe(8);
    expect(metrics?.favorites).toBe(9);
    expect(metrics?.shares).toBe(3);
  });

  it('returns null for unsupported hosts and empty pages', () => {
    expect(collectMetrics(environment('https://weibo.com/u/1', XIAOHONGSHU_NOTE_MANAGER_PAGE))).toBeNull();
    expect(collectMetrics(environment('about:blank', ''))).toBeNull();
    expect(collectMetrics(environment(DOUYIN_DATA_URL, UNRELATED_PAGE))).toBeNull();
  });
});

describe('collectDataPageMetrics (automatic reporting path)', () => {
  it('ignores authoring pages even when they contain numbers', () => {
    const editorUrl = 'https://baijiahao.baidu.com/builder/rc/edit?type=news';
    expect(collectDataPageMetrics(environment(editorUrl, BAIJIAHAO_CONTENT_PAGE))).toBeNull();
    // An explicit pull is not path gated, so the same page still reads when asked for it.
    expect(collectMetrics(environment(editorUrl, BAIJIAHAO_CONTENT_PAGE))?.views).toBe(3456);
    expect(collectDataPageMetrics(environment(BAIJIAHAO_DATA_URL, BAIJIAHAO_CONTENT_PAGE))?.views).toBe(3456);
  });

  it('reports a data page', () => {
    const metrics = collectDataPageMetrics(environment(XIAOHONGSHU_DATA_URL, XIAOHONGSHU_NOTE_MANAGER_PAGE));
    expect(metrics?.platform).toBe('xiaohongshu');
    expect(metrics?.views).toBe(12000);
  });
});
