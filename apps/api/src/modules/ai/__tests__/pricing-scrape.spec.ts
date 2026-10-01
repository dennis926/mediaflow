import { describe, expect, it } from 'vitest';
import { cellText, extractTables, parseNumber } from '../pricing/html-table';
import { parseDeepseekPricing } from '../pricing/deepseek-pricing';
import { describeWindows, tierAt, zonedDateKey } from '../pricing/peak-window';

/**
 * A trimmed copy of DeepSeek's published pricing table (2026-10).
 *
 * Kept verbatim in structure — including the colspan quirk where the first
 * dimension label shares a row with the tier label — because that quirk is
 * exactly what a naive parser gets wrong (it silently drops the off-peak row).
 */
const DEEPSEEK_TABLE = `
<table>
  <tr><th>模型</th><th>deepseek-flash(1)</th><th>deepseek-v4-pro</th></tr>
  <tr><td>BASE URL (OpenAI 格式)</td><td colspan="2">https://api.deepseek.com</td></tr>
  <tr><td>模型版本</td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr>
  <tr><td>上下文长度</td><td colspan="2">1M</td></tr>
  <tr><td>价格(2)</td><td colspan="2">百万tokens输入（缓存命中）</td></tr>
  <tr><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
  <tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
  <tr><td colspan="3">百万tokens输入（缓存未命中）</td></tr>
  <tr><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
  <tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
  <tr><td colspan="3">百万tokens输出</td></tr>
  <tr><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
  <tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
  <tr><td>并发限制(3)</td><td>2500</td><td>500</td></tr>
</table>
`;

describe('HTML 表格抽取', () => {
  it('去标签并解码实体', () => {
    expect(cellText('<td>1&lt;2 &amp; 3&gt;2</td>')).toBe('1<2 & 3>2');
  });

  it('从单元格里取数字（含单位与千分位）', () => {
    expect(parseNumber('0.02元')).toBe(0.02);
    expect(parseNumber('￥1,200.50')).toBe(1200.5);
    expect(parseNumber('支持')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });

  it('按行列还原表格', () => {
    const tables = extractTables('<table><tr><td>a</td><td>b</td></tr></table>');
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([['a', 'b']]);
  });
});

describe('DeepSeek 官网价目解析', () => {
  const prices = parseDeepseekPricing(DEEPSEEK_TABLE);

  it('解析出页面上的全部模型', () => {
    expect(prices.map((price) => price.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('flash 的峰谷三段价与官网公布值一致', () => {
    const flash = prices.find((price) => price.model === 'deepseek-flash');
    expect(flash?.peak).toEqual({ input: 2, output: 8, cacheRead: 0.04 });
    expect(flash?.offpeak).toEqual({ input: 1, output: 4, cacheRead: 0.02 });
  });

  it('pro 的峰谷三段价与官网公布值一致', () => {
    const pro = prices.find((price) => price.model === 'deepseek-v4-pro');
    expect(pro?.peak).toEqual({ input: 9, output: 27, cacheRead: 0.3 });
    expect(pro?.offpeak).toEqual({ input: 4.5, output: 13.5, cacheRead: 0.15 });
  });

  it('空闲价恰好是高峰价的一半（官网脚注所述规则）', () => {
    for (const price of prices) {
      expect(price.offpeak.input).toBeCloseTo(price.peak.input / 2, 6);
      expect(price.offpeak.output).toBeCloseTo(price.peak.output / 2, 6);
    }
  });

  it('页面结构变化时返回空数组而不是猜价格', () => {
    expect(parseDeepseekPricing('<table><tr><td>改版了</td></tr></table>')).toEqual([]);
    expect(parseDeepseekPricing('')).toEqual([]);
  });
});

describe('峰谷时段判定', () => {
  const config = {
    windows: [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
      { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
    ],
    holidays: [] as string[],
    timeZone: 'Asia/Shanghai',
  };

  it('按北京时间判定（周四 10:00 是高峰）', () => {
    expect(tierAt(new Date('2026-10-01T02:00:00.000Z'), config)).toBe('peak');
  });

  it('午休空档是空闲（周四 12:30）', () => {
    expect(tierAt(new Date('2026-10-01T04:30:00.000Z'), config)).toBe('offpeak');
  });

  it('下午高峰（周四 15:00）', () => {
    expect(tierAt(new Date('2026-10-01T07:00:00.000Z'), config)).toBe('peak');
  });

  it('窗口右端是开区间（周四 18:00 整已空闲）', () => {
    expect(tierAt(new Date('2026-10-01T10:00:00.000Z'), config)).toBe('offpeak');
  });

  it('周末全天空闲（周六 10:00）', () => {
    expect(tierAt(new Date('2026-10-03T02:00:00.000Z'), config)).toBe('offpeak');
  });

  it('节假日全天空闲', () => {
    const withHoliday = { ...config, holidays: ['2026-10-01'] };
    expect(tierAt(new Date('2026-10-01T02:00:00.000Z'), withHoliday)).toBe('offpeak');
  });

  it('窗口为空时一律空闲（宁可少算，不可虚高）', () => {
    expect(tierAt(new Date('2026-10-01T02:00:00.000Z'), { windows: [], holidays: [], timeZone: 'Asia/Shanghai' })).toBe(
      'offpeak',
    );
  });

  it('日期键按目标时区计算', () => {
    // 北京时间 10-01 08:00 对应 UTC 10-01 00:00；UTC 前一天 16:00 仍是北京 10-02
    expect(zonedDateKey(new Date('2026-10-01T00:00:00.000Z'), 'Asia/Shanghai')).toBe('2026-10-01');
    expect(zonedDateKey(new Date('2026-10-01T16:00:00.000Z'), 'Asia/Shanghai')).toBe('2026-10-02');
  });

  it('人类可读的窗口描述', () => {
    expect(describeWindows(config)).toContain('09:00-12:00');
    expect(describeWindows(config)).toContain('14:00-18:00');
  });
});
