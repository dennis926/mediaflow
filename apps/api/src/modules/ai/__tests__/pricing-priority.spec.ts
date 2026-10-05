import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../settings/settings.service';
import { ProviderConfigService } from '../provider-config.service';
import { ModelPricingService } from '../model-pricing.service';
import { OfficialPriceStore } from '../pricing/official-price.store';

/**
 * 价格优先级：用户覆盖价 > 官网抓取价 > 聚合价目表（models.dev）> 预置目录价 > 全局兜底价。
 *
 * 这组用例守的是**聚合价绝不能越级**。models.dev 是美元聚合价，且把 DeepSeek 的
 * 峰谷拍平成了单档：若它盖住官网抓取价，高峰时段会按谷价计费——少收一半。
 * 引入它的目的只是补上官网抓不到的三家（OpenAI / MiniMax / 豆包）。
 */
function build(settings: Record<string, string>, snapshot: unknown): ModelPricingService {
  const values: Record<string, string> = { AI_USD_CNY_RATE: '7', ...settings };
  const svc = {
    get: vi.fn(async (key: string) => values[key] ?? null),
    updateMany: vi.fn(async () => undefined),
  } as unknown as SettingsService;
  const providers = { list: vi.fn(async () => []) } as unknown as ProviderConfigService;
  const store = {
    read: vi.fn(async () => snapshot),
    scrapableProviders: vi.fn(async () => [] as const),
  } as unknown as OfficialPriceStore;
  return new ModelPricingService(svc, providers, store);
}

/** 官网抓取价：DeepSeek 人民币、分峰谷两档。 */
const OFFICIAL_SNAPSHOT = {
  fetchedAt: '2026-10-02T00:00:00.000Z',
  sources: { deepseek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' },
  providers: {
    deepseek: {
      'deepseek-flash': {
        model: 'deepseek-flash',
        currency: 'CNY',
        peak: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.04 },
        offpeak: { input: 1, output: 4, cacheWrite: 1, cacheRead: 0.02 },
      },
    },
  },
  detail: {},
  /** 聚合价目表：同一模型被拍平成谷价（这正是它不能越级的原因）。 */
  aggregate: {
    fetchedAt: '2026-10-02T00:00:00.000Z',
    sourceUrl: 'https://models.dev/api.json',
    providers: {
      deepseek: {
        'deepseek-flash': {
          model: 'deepseek-flash',
          catalogModel: 'deepseek-flash',
          currency: 'USD',
          peak: { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.003 },
          offpeak: { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.003 },
        },
      },
      // 官网抓不到的供应商：只有聚合价
      openai: {
        'gpt-5-mini': {
          model: 'gpt-5-mini',
          catalogModel: 'gpt-5-mini',
          currency: 'USD',
          peak: { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
          offpeak: { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
        },
      },
      minimax: {
        'MiniMax-M3': {
          model: 'MiniMax-M3',
          catalogModel: 'minimax-m3',
          currency: 'USD',
          peak: { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.06 },
          offpeak: { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.06 },
        },
      },
    },
  },
  /**
   * 国内权威参考价（国家超算互联网）：人民币口径。
   * 它必须**优先于**上面的美元聚合价：人民币参考价无需汇率换算，更可靠。
   * 这里刻意让同一模型在两层都有价，用来验证优先级真的生效。
   * 注意两层的 MiniMax 数值刻意不同（国内 ￥2.1 vs 聚合 $0.3→￥2.1 恰好相同，
   * 故 deepseek 层用不同数值区分来源）。
   */
  domestic: {
    fetchedAt: '2026-10-02T00:00:00.000Z',
    sourceUrl: 'https://www.scnet.cn/acx/llm/api/console/model/landing',
    providers: {
      deepseek: {
        'DeepSeek-V4.1-Flash': {
          model: 'DeepSeek-V4.1-Flash',
          catalogModel: 'deepseek-flash',
          currency: 'CNY',
          peak: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.2 },
          offpeak: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.2 },
        },
      },
      // 官网抓不到、聚合价是美元 → 国内权威价（人民币）应当胜出
      minimax: {
        'MiniMax-M3': {
          model: 'MiniMax-M3',
          catalogModel: 'minimax-m3',
          currency: 'CNY',
          peak: { input: 2.1, output: 8.4, cacheWrite: 2.1, cacheRead: 0.42 },
          offpeak: { input: 2.1, output: 8.4, cacheWrite: 2.1, cacheRead: 0.42 },
        },
      },
    },
  },
};

/** 北京时间周四 10:00 → 高峰时段。 */
const PEAK = new Date('2026-10-01T02:00:00.000Z');
/** 北京时间周四 08:30 → 空闲时段。 */
const OFFPEAK = new Date('2026-10-01T00:30:00.000Z');

const PEAK_WINDOWS = JSON.stringify({
  windows: [
    { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
    { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
  ],
  holidays: [],
  timeZone: 'Asia/Shanghai',
});

describe('价格优先级：聚合价目表只能兜底', () => {
  it('有官网抓取价时，高峰时段取官网高峰价，不被聚合价拉平', async () => {
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }, OFFICIAL_SNAPSHOT).priceFor(
      'deepseek',
      'deepseek-flash',
      undefined,
      { at: PEAK },
    );
    expect(view.source).toBe('official');
    expect(view.tier).toBe('peak');
    // 官网高峰 ￥2 / ￥8；若被聚合价盖住会变成 0.15×7=￥1.05
    expect(view.price.input).toBe(2);
    expect(view.price.output).toBe(8);
  });

  it('空闲时段仍取官网空闲档（不是聚合价的同一档）', async () => {
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }, OFFICIAL_SNAPSHOT).priceFor(
      'deepseek',
      'deepseek-flash',
      undefined,
      { at: OFFPEAK },
    );
    expect(view.source).toBe('official');
    expect(view.price.input).toBe(1);
    expect(view.price.output).toBe(4);
  });

  it('官网抓不到时用聚合价，并按汇率折成人民币', async () => {
    const view = await build({}, OFFICIAL_SNAPSHOT).priceFor('openai', 'gpt-5-mini');
    expect(view.source).toBe('aggregate');
    // 0.25 美元 × 7 = ￥1.75
    expect(view.price.input).toBe(1.75);
    expect(view.price.output).toBe(14);
    expect(view.tiered).toBe(false);
  });

  it('MiniMax 官网抓不到：优先用国内权威参考价（人民币），而不是美元聚合价', async () => {
    const view = await build({}, OFFICIAL_SNAPSHOT).priceFor('minimax', 'minimax-m3');
    // 两层都有价：国内权威价（￥2.1/￥8.4）与聚合价（$0.3/￥1.2 → 折算 ￥2.1/￥8.4）。
    // 人民币口径优先，且不做汇率换算。
    expect(view.source).toBe('domestic');
    expect(view.price.input).toBe(2.1);
    expect(view.price.output).toBe(8.4);
  });

  it('国内权威价是人民币，绝不乘汇率', async () => {
    // 若误当美元折算，￥2.1 会变成 ￥14.7
    const view = await build({}, OFFICIAL_SNAPSHOT).priceFor('minimax', 'minimax-m3');
    expect(view.price.input).not.toBe(14.7);
    expect(view.price.input).toBe(2.1);
  });

  it('国内权威价不越过官网抓取价', async () => {
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }, OFFICIAL_SNAPSHOT).priceFor(
      'deepseek',
      'deepseek-flash',
      undefined,
      { at: PEAK },
    );
    // 官网高峰 ￥2/￥8 与国内权威价数值相同，但来源必须是官网（可区分峰谷）
    expect(view.source).toBe('official');
    expect(view.tiered).toBe(true);
  });

  it('两层兜底都没有时回落到预置目录价', async () => {
    const view = await build({}, OFFICIAL_SNAPSHOT).priceFor('google', 'gemini-3.8-flash');
    expect(view.source).toBe('catalog');
  });

  it('用户覆盖价高于官网价与聚合价', async () => {
    const overrides = JSON.stringify({
      'openai/gpt-5-mini': { input: 99, output: 99, cacheWrite: 99, cacheRead: 99 },
    });
    const view = await build({ AI_MODEL_PRICES: overrides }, OFFICIAL_SNAPSHOT).priceFor('openai', 'gpt-5-mini');
    expect(view.source).toBe('override');
    expect(view.price.input).toBe(99);
  });

  it('聚合价里没有的模型回落到预置目录价', async () => {
    const view = await build({}, OFFICIAL_SNAPSHOT).priceFor('anthropic', 'claude-opus-5-5');
    expect(view.source).toBe('catalog');
    expect(view.price.input).toBe(28);
  });

  it('聚合价抓取失败（只剩上一份）时不影响官网价', async () => {
    const failed = {
      ...OFFICIAL_SNAPSHOT,
      aggregate: { ...OFFICIAL_SNAPSHOT.aggregate, error: 'models.dev 返回 HTTP 503' },
    };
    const view = await build({ AI_PEAK_WINDOWS: PEAK_WINDOWS }, failed).priceFor('deepseek', 'deepseek-flash', undefined, {
      at: PEAK,
    });
    expect(view.source).toBe('official');
    expect(view.price.input).toBe(2);
  });

  it('聚合价按 catalogModel 反查（聚合表 id 带日期戳）', async () => {
    const snapshot = {
      ...OFFICIAL_SNAPSHOT,
      aggregate: {
        ...OFFICIAL_SNAPSHOT.aggregate,
        providers: {
          doubao: {
            'doubao-seed-2-1-pro-260628': {
              model: 'doubao-seed-2-1-pro-260628',
              catalogModel: 'doubao-seed-2.1-pro',
              currency: 'USD',
              peak: { input: 0.8906, output: 4.45301, cacheWrite: 0.8906, cacheRead: 0.17812 },
              offpeak: { input: 0.8906, output: 4.45301, cacheWrite: 0.8906, cacheRead: 0.17812 },
            },
          },
        },
      },
    };
    const view = await build({}, snapshot).priceFor('doubao', 'doubao-seed-2.1-pro');
    expect(view.source).toBe('aggregate');
    expect(view.price.input).toBeCloseTo(6.2342, 3);
  });
});
