import { describe, expect, it } from 'vitest';
import { parseCount } from '../content/metrics/number';

describe('parseCount', () => {
  it('keeps plain integers and floors decimals', () => {
    expect(parseCount(12000)).toBe(12000);
    expect(parseCount(0)).toBe(0);
    expect(parseCount('0')).toBe(0);
    expect(parseCount(12.9)).toBe(12);
    expect(parseCount('42')).toBe(42);
  });

  it('understands thousands separators', () => {
    expect(parseCount('1,234')).toBe(1234);
    expect(parseCount('1,234,567')).toBe(1234567);
    expect(parseCount(' 2,345 ')).toBe(2345);
    expect(parseCount('1，234')).toBe(1234);
  });

  it('converts the 万/亿/k suffixes', () => {
    expect(parseCount('1.2万')).toBe(12000);
    expect(parseCount('15.6万')).toBe(156000);
    expect(parseCount('3.2万')).toBe(32000);
    expect(parseCount('58万')).toBe(580000);
    expect(parseCount('3.4亿')).toBe(340000000);
    expect(parseCount('12.5k')).toBe(12500);
    expect(parseCount('2w')).toBe(20000);
    expect(parseCount('1,234万')).toBe(12340000);
  });

  it('ignores decorations and trailing units', () => {
    expect(parseCount('58万+')).toBe(580000);
    expect(parseCount('1.2万次播放')).toBe(12000);
    expect(parseCount('128 次')).toBe(128);
    expect(parseCount('约 3,456 阅读')).toBe(3456);
  });

  it('returns null for empty counters and unusable input', () => {
    expect(parseCount('')).toBeNull();
    expect(parseCount('   ')).toBeNull();
    expect(parseCount('—')).toBeNull();
    expect(parseCount('--')).toBeNull();
    expect(parseCount('暂无数据')).toBeNull();
    expect(parseCount('隐藏')).toBeNull();
    expect(parseCount('暂无')).toBeNull();
    expect(parseCount('abc')).toBeNull();
    expect(parseCount('-5')).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(parseCount(undefined)).toBeNull();
    expect(parseCount({})).toBeNull();
    expect(parseCount(Number.NaN)).toBeNull();
    expect(parseCount(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
