import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../settings/settings.service';
import { ProviderConfigService } from '../provider-config.service';
import { ModelPricingService } from '../model-pricing.service';

/** 用内存设置表搭一个最小可用的 SettingsService。 */
function build(overrides: Record<string, string> = {}): ModelPricingService {
  const values: Record<string, string> = { AI_USD_CNY_RATE: '7', ...overrides };
  const settings = { get: vi.fn(async (key: string) => values[key]), updateMany: vi.fn(async () => undefined) } as unknown as SettingsService;
  const providers = { list: vi.fn(async () => []) } as unknown as ProviderConfigService;
  return new ModelPricingService(settings, providers);
}

describe('模型计价（官方价 + 覆盖价）', () => {
  it('未覆盖时用官方美元价 × 汇率', async () => {
    const view = await build().priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('catalog');
    expect(view.price.input).toBeCloseTo(1.96, 4);
    expect(view.price.output).toBeCloseTo(2.94, 4);
  });

  it('只覆盖输入价时，其它段仍按官方价折算（不会被悄悄变成 0）', async () => {
    const view = await build({ AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 5 } }) }).priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('override');
    expect(view.price.input).toBe(5);
    expect(view.price.output).toBeCloseTo(2.94, 4);
    expect(view.price.cacheRead).toBeCloseTo(0.196, 4);
  });

  it('全 0 的覆盖记录视为无效，回落到官方价', async () => {
    const view = await build({ AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }) }).priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('catalog');
  });

  it('显式把某段设为 0 是允许的（例如自建代理不收缓存费）', async () => {
    const view = await build({ AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 2, output: 3, cacheWrite: 0, cacheRead: 0 } }) }).priceFor('deepseek', 'deepseek-flash');
    expect(view.source).toBe('override');
    expect(view.price.cacheRead).toBe(0);
    expect(view.price.input).toBe(2);
  });

  it('删除覆盖后回到官方价', async () => {
    const service = build({ AI_MODEL_PRICES: JSON.stringify({ 'deepseek/deepseek-flash': { input: 9 } }) });
    await service.clearOverride('deepseek/deepseek-flash');
    const settings = (service as unknown as { settings: { updateMany: (items: Array<{ key: string; value: string }>) => Promise<void> } }).settings;
    expect(settings.updateMany).toHaveBeenCalledWith([{ key: 'AI_MODEL_PRICES', value: '{}' }], expect.anything());
  });
});
