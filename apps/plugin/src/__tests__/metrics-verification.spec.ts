import { describe, expect, it } from 'vitest';
import { parseCount } from '../content/metrics/number';
import { isMetricsDataPage, parseMetrics, platformForUrl } from '../content/metrics/parsers';
import { DOUYIN_DATA_PAGE, DOUYIN_DATA_URL, UNRELATED_PAGE } from './fixtures/creator-pages';

describe('独立验证：数字换算', () => {
  it('中文单位与千分位换算正确', () => {
    expect(parseCount('2.3万')).toBe(23000);
    expect(parseCount('1,204')).toBe(1204);
    expect(parseCount('100万+')).toBe(1000000);
    expect(parseCount('--')).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(parseCount('')).toBeNull();
  });
});

describe('独立验证：页面解析的健壮性', () => {
  it('无关页面不会被当成数据页，解析返回 null 而不是抛异常', () => {
    expect(platformForUrl('https://weibo.com/u/1')).toBeNull();
    expect(isMetricsDataPage('https://weibo.com/u/1')).toBe(false);
    expect(parseMetrics('douyin', { html: '<html><body>nothing</body></html>' })).toBeNull();
    expect(parseMetrics('nosuchplatform', { html: UNRELATED_PAGE })).toBeNull();
  });

  it('真实抖音数据页 fixture 能解析出数值指标', () => {
    expect(platformForUrl(DOUYIN_DATA_URL)).toBe('douyin');
    const parsed = parseMetrics('douyin', { html: DOUYIN_DATA_PAGE, url: DOUYIN_DATA_URL });
    expect(parsed).not.toBeNull();
    const numbers = Object.entries(parsed ?? {}).filter(([, value]) => typeof value === 'number');
    expect(numbers.length).toBeGreaterThan(0);
  });
});
