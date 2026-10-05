import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../settings/settings.service';
import { ProviderConfigService, type ProviderConfig } from '../provider-config.service';
import { ModelPricingService } from '../model-pricing.service';
import { OfficialPriceStore } from '../pricing/official-price.store';

/**
 * 第三方中转渠道的计费口径。
 *
 * 真实需求：用户不一定用官方 API，也常用第三方中转站。中转的麻烦在于——
 * ① 通常有倍率（1:1、1:5…），按官方价算会**低估成本**；
 * ② 一个中转渠道常同时代理多家模型，按单一供应商的官方价算必然对不上；
 * ③ 模型名常带后缀或自定义，查不到官方价。
 *
 * 以上三条都不会报错，只会静默给出错误的成本数字。所以中转渠道必须：
 * - 一律不查官方价（哪怕官网抓取价里有同款模型）；
 * - 只认用户在该渠道填的价格（走 override 通道）；
 * - 没填则显式标记为 relay 价，而不是伪装成"官方价"。
 */

function build(configs: ProviderConfig[], settings: Record<string, string> = {}): ModelPricingService {
  const values: Record<string, string> = { AI_USD_CNY_RATE: '7', ...settings };
  const svc = {
    get: vi.fn(async (key: string) => values[key] ?? null),
    updateMany: vi.fn(async () => undefined),
  } as unknown as SettingsService;
  const providers = { list: vi.fn(async () => configs) } as unknown as ProviderConfigService;
  const store = {
    read: vi.fn(async () => ({
      fetchedAt: '2026-10-05T00:00:00.000Z',
      sources: {},
      providers: {},
      detail: {},
      aggregate: { fetchedAt: null, sourceUrl: '', providers: {} },
    })),
    scrapableProviders: vi.fn(async () => [] as const),
  } as unknown as OfficialPriceStore;
  return new ModelPricingService(svc, providers, store);
}

/** 官方抓取价里有 DeepSeek 的价格：中转代理同款模型时绝不能套用它。 */
const OFFICIAL_DEEPSEEK = {
  fetchedAt: '2026-10-05T00:00:00.000Z',
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
  aggregate: { fetchedAt: null, sourceUrl: '', providers: {} },
};

function relayConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider: 'deepseek',
    kind: 'relay',
    label: '某聚合中转',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-relay',
    models: ['deepseek-flash'],
    protocol: 'openai-compatible',
    ...overrides,
  };
}

describe('第三方中转渠道的计费', () => {
  it('中转渠道即使与官方同款模型，也不得套用官方价', async () => {
    const svc = build([relayConfig()]);
    // 注入官方价，模拟"官网抓到了价格"的真实情况
    (svc as unknown as { officialPrices: { read: () => Promise<unknown> } }).officialPrices.read = vi.fn(
      async () => OFFICIAL_DEEPSEEK,
    );

    const view = await svc.priceFor('deepseek', 'deepseek-flash');
    // 全局兜底价默认 0，所以这里的关键是 source 不能是 official/catalog
    expect(view.source).toBe('relay');
    expect(view.officialCny).toBeNull();
  });

  it('中转渠道填了价格就用填的价（走 override 通道）', async () => {
    const svc = build([relayConfig()], {
      AI_MODEL_PRICES: JSON.stringify({
        'deepseek/deepseek-flash': { input: 6, output: 24, cacheRead: 0.12 },
      }),
    });
    const view = await svc.priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('override');
    expect(view.price.input).toBe(6);
    expect(view.price.output).toBe(24);
  });

  it('官方直连渠道行为不变：仍自动套用官网抓取价', async () => {
    const svc = build([
      { ...relayConfig(), kind: 'official', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    ]);
    (svc as unknown as { officialPrices: { read: () => Promise<unknown> } }).officialPrices.read = vi.fn(
      async () => OFFICIAL_DEEPSEEK,
    );
    const view = await svc.priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('official');
    expect(view.price.input).toBeGreaterThan(0);
  });

  it('旧配置没有 kind 字段时按官方直连处理（升级不改变行为）', async () => {
    const legacy = relayConfig();
    delete legacy.kind;
    const svc = build([legacy]);
    (svc as unknown as { officialPrices: { read: () => Promise<unknown> } }).officialPrices.read = vi.fn(
      async () => OFFICIAL_DEEPSEEK,
    );
    const view = await svc.priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('official');
  });

  it('中转渠道只列用户填的模型，不混入预置目录模型', async () => {
    const svc = build([relayConfig({ models: ['relay-deepseek-v4'] })]);
    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].models.map((m) => m.model)).toEqual(['relay-deepseek-v4']);
    expect(list[0].kind).toBe('relay');
  });

  it('中转渠道不做官网抓取（地址不是官方域名，抓了也抓不到）', async () => {
    const svc = build([relayConfig()]);
    const list = await svc.list();
    expect(list[0].scrapable).toBe(false);
  });

  it('官方渠道仍会列出预置目录里的模型（用户少填也不漏）', async () => {
    const svc = build([
      {
        provider: 'deepseek',
        kind: 'official',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-x',
        models: ['deepseek-flash'],
        protocol: 'openai-compatible',
      },
    ]);
    const list = await svc.list();
    expect(list[0].models.map((m) => m.model)).toContain('deepseek-v4-pro');
  });

  it('中转渠道的价格进入成本核算，且用填定的单价', () => {
    const svc = build([relayConfig()], {
      AI_MODEL_PRICES: JSON.stringify({
        'deepseek/deepseek-flash': { input: 6, output: 24 },
      }),
    });
    return svc.costOf('deepseek', 'deepseek-flash', { input: 1_000_000, output: 1_000_000 }).then((quote) => {
      // 1M 输入 + 1M 输出，单价 6 + 24 = 30 元
      expect(quote.cost).toBe('30.000000');
      expect(quote.source).toBe('override');
    });
  });
});
