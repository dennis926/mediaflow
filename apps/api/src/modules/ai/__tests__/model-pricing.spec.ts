import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../settings/settings.service';
import { ProviderConfigService } from '../provider-config.service';
import { ModelPricingService } from '../model-pricing.service';
import { OfficialPriceStore } from '../pricing/official-price.store';

/** 用内存设置表搭一个最小可用的 SettingsService。 */
function build(overrides: Record<string, string> = {}, snapshot: unknown = null): ModelPricingService {
  const values: Record<string, string> = { AI_USD_CNY_RATE: '7', ...overrides };
  const settings = {
    get: vi.fn(async (key: string) => values[key] ?? null),
    updateMany: vi.fn(async () => undefined),
  } as unknown as SettingsService;
  const providers = { list: vi.fn(async () => []) } as unknown as ProviderConfigService;
  const store = {
    read: vi.fn(async () => snapshot),
    save: vi.fn(async () => snapshot),
    scrapableProviders: vi.fn(async () => ['deepseek'] as const),
  } as unknown as OfficialPriceStore;
  return new ModelPricingService(settings, providers, store);
}

/** 官方公布的高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00）。 */
const PEAK_WINDOWS = JSON.stringify({
  windows: [
    { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
    { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
  ],
  holidays: [],
  timeZone: 'Asia/Shanghai',
});

/** 2026-10-01 是周四（国庆假期，但我们的配置里未列为节假日）。 */
const THURSDAY_PEAK = new Date('2026-10-01T02:00:00.000Z'); // 北京时间 10:00 → 高峰
const THURSDAY_OFFPEAK = new Date('2026-10-01T00:30:00.000Z'); // 北京时间 08:30 → 空闲（09:00 起才是高峰）
const SATURDAY = new Date('2026-10-03T02:00:00.000Z'); // 周六 10:00 → 空闲

describe('模型计价（官方人民币峰谷价 + 覆盖价）', () => {
  it('DeepSeek 用官方人民币价，高峰时段取高峰档', async () => {
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }).priceFor('deepseek', 'deepseek-flash', undefined, {
      at: THURSDAY_PEAK,
    });
    expect(view.source).toBe('catalog');
    expect(view.tier).toBe('peak');
    expect(view.tiered).toBe(true);
    expect(view.price.input).toBe(2);
    expect(view.price.output).toBe(8);
    expect(view.price.cacheRead).toBe(0.04);
  });

  it('同一模型在空闲时段取空闲档（半价）', async () => {
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }).priceFor('deepseek', 'deepseek-flash', undefined, {
      at: THURSDAY_OFFPEAK,
    });
    expect(view.tier).toBe('offpeak');
    expect(view.price.input).toBe(1);
    expect(view.price.output).toBe(4);
    expect(view.price.cacheRead).toBe(0.02);
  });

  it('周末全天按空闲计价', async () => {
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }).priceFor('deepseek', 'deepseek-flash', undefined, {
      at: SATURDAY,
    });
    expect(view.tier).toBe('offpeak');
    expect(view.price.input).toBe(1);
  });

  it('节假日全天按空闲计价', async () => {
    const config = JSON.stringify({
      windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }],
      holidays: ['2026-10-01'],
      timeZone: 'Asia/Shanghai',
    });
    const view = await build({ AI_PEAK_WINDOWS: config }).priceFor('deepseek', 'deepseek-flash', undefined, {
      at: THURSDAY_PEAK,
    });
    expect(view.tier).toBe('offpeak');
    expect(view.price.input).toBe(1);
  });

  it('未配置峰谷窗口时不分峰谷（海外供应商按汇率折算）', async () => {
    const view = await build().priceFor('openai', 'gpt-5.5');
    expect(view.tier).toBe('offpeak');
    expect(view.tiered).toBe(false);
    expect(view.price.input).toBeCloseTo(8.75, 4);
    expect(view.price.output).toBeCloseTo(70, 4);
  });

  it('官网抓取价优先于预置目录价', async () => {
    const snapshot = {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      sources: { deepseek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' },
      providers: {
        deepseek: {
          'deepseek-flash': {
            model: 'deepseek-flash',
            peak: { input: 2.5, output: 9, cacheRead: 0.05 },
            offpeak: { input: 1.25, output: 4.5, cacheRead: 0.025 },
          },
        },
      },
    };
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }, snapshot).priceFor('deepseek', 'deepseek-flash', undefined, {
      at: THURSDAY_PEAK,
    });
    expect(view.source).toBe('official');
    expect(view.price.input).toBe(2.5);
  });

  it('只覆盖输入价时，其它段仍按官方价（不会被悄悄变成 0）', async () => {
    const view = await build({ AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 5 } }) }).priceFor(
      'deepseek',
      'deepseek-flash',
    );
    expect(view.source).toBe('override');
    expect(view.price.input).toBe(5);
    // 无峰谷配置 → 空闲档：输出 4、缓存 0.02
    expect(view.price.output).toBe(4);
    expect(view.price.cacheRead).toBe(0.02);
  });

  it('全 0 的覆盖记录视为无效，回落到官方价', async () => {
    const view = await build({
      AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
    }).priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('catalog');
  });

  it('显式把某段设为 0 是允许的（例如自建代理不收缓存费）', async () => {
    const view = await build({
      AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 2, output: 3, cacheWrite: 0, cacheRead: 0 } }),
    }).priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('override');
    expect(view.price.cacheRead).toBe(0);
    expect(view.price.input).toBe(2);
  });

  it('删除覆盖后回到官方价', async () => {
    const service = build({ AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 9 } }) });
    await service.clearOverride('deepseek/deepseek-flash');
    const settings = (service as unknown as { settings: { updateMany: (items: Array<{ key: string; value: string }>) => Promise<void> } })
      .settings;
    expect(settings.updateMany).toHaveBeenCalledWith([{ key: 'AI_MODEL_PRICES', value: '{}' }], expect.anything());
  });

  it('按调用时刻计价：高峰一次调用比空闲贵一倍', async () => {
    const service = build({ AI_PEAK_WINDOWS: PEAK_WINDOWS });
    const tokens = { input: 1_000_000, output: 1_000_000 };
    const peak = await service.costOf('deepseek', 'deepseek-flash', tokens, { at: THURSDAY_PEAK });
    const offpeak = await service.costOf('deepseek', 'deepseek-flash', tokens, { at: THURSDAY_OFFPEAK });
    expect(Number(peak.cost)).toBeCloseTo(10, 6);
    expect(Number(offpeak.cost)).toBeCloseTo(5, 6);
    expect(peak.tier).toBe('peak');
    expect(offpeak.tier).toBe('offpeak');
  });
});
