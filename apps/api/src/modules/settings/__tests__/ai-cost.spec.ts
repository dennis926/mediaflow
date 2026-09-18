import { afterEach, describe, expect, it } from 'vitest';
import { applyRuntimeConfig, costBreakdown, estimateCost } from '../runtime-config';

describe('AI 三段计价（输入未命中 / 输入缓存命中 / 输出）', () => {
  afterEach(() => applyRuntimeConfig({}));

  it('未配置单价时不计费', () => {
    applyRuntimeConfig({});
    expect(estimateCost(1_000_000, 1_000_000, 500_000)).toBe('0');
  });

  it('按三段分别计价（缓存命中更便宜）', () => {
    applyRuntimeConfig({
      AI_PRICE_INPUT_PER_MTOK: '2',
      AI_PRICE_CACHED_INPUT_PER_MTOK: '0.5',
      AI_PRICE_OUTPUT_PER_MTOK: '8',
    });

    // 输入 1,000,000（其中缓存命中 600,000）→ 未命中 400,000；输出 250,000
    // = 0.4×2 + 0.6×0.5 + 0.25×8 = 0.8 + 0.3 + 2 = 3.1
    expect(estimateCost(1_000_000, 250_000, 600_000)).toBe('3.100000');
  });

  it('未配置缓存价时退化为未命中价（等价旧算法）', () => {
    applyRuntimeConfig({ AI_PRICE_INPUT_PER_MTOK: '2', AI_PRICE_OUTPUT_PER_MTOK: '8' });
    expect(estimateCost(1_000_000, 0, 1_000_000)).toBe('2.000000');
  });

  it('缓存数超过输入数时按输入数截断（脏数据不产生负费用）', () => {
    applyRuntimeConfig({ AI_PRICE_INPUT_PER_MTOK: '2', AI_PRICE_CACHED_INPUT_PER_MTOK: '0.5', AI_PRICE_OUTPUT_PER_MTOK: '8' });
    expect(estimateCost(1_000_000, 0, 9_999_999)).toBe('0.500000');
  });

  it('明细里单价与金额逐项可核对，且合计等于三段之和', () => {
    applyRuntimeConfig({ AI_PRICE_INPUT_PER_MTOK: '2', AI_PRICE_CACHED_INPUT_PER_MTOK: '0.5', AI_PRICE_OUTPUT_PER_MTOK: '8' });
    const detail = costBreakdown({ tokensInput: 1_000_000, tokensOutput: 250_000, tokensCached: 600_000 });

    expect(detail.inputMissed).toMatchObject({ tokens: 400_000, unitPrice: 2, amount: '0.800000' });
    expect(detail.inputCached).toMatchObject({ tokens: 600_000, unitPrice: 0.5, amount: '0.300000' });
    expect(detail.output).toMatchObject({ tokens: 250_000, unitPrice: 8, amount: '2.000000' });
    const sum = Number(detail.inputMissed.amount) + Number(detail.inputCached.amount) + Number(detail.output.amount);
    expect(Number(detail.total)).toBeCloseTo(sum, 6);
  });
});
