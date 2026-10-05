import { describe, expect, it } from 'vitest';
import {
  SCNET_BRANDS,
  SCNET_PRICING_URL,
  matchScnetModel,
  parseScnetPricing,
} from '../pricing/scnet';
import {
  MODELS_DEV_PROVIDERS,
  MODELS_DEV_PROVIDERS_FALLBACK,
  currencyOfModelsDevProvider,
  parseModelsDev,
} from '../pricing/models-dev';

/**
 * 国内权威参考价（国家超算互联网）解析测试。
 *
 * 用真实接口响应做样本：这个接口的字段类型（价格是字符串、品牌是中文）与
 * 我们内部结构差异很大，用构造的干净数据测不出真实故障。
 */
const SCNET_FIXTURE = {
  code: '0',
  msg: 'success',
  data: [
    {
      id: '173',
      modelName: 'DeepSeek-V4.1-Flash',
      brand: 'DeepSeek',
      inputPrice: 2.0,
      cachedPrice: 0.2,
      outputPrice: 8.0,
      description: '【暂不支持闲忙时定价】...',
    },
    {
      id: '137',
      modelName: 'Kimi-K3',
      brand: '月之暗面',
      inputPrice: 20.0,
      cachedPrice: 2.0,
      outputPrice: 100.0,
    },
    {
      id: '156',
      modelName: 'Qwen3.8-Flash',
      brand: 'Qwen',
      inputPrice: 0.8,
      cachedPrice: 0.1,
      outputPrice: 2.7,
    },
    {
      id: '152',
      modelName: 'GLM-5.3',
      brand: '智谱AI',
      inputPrice: 8.0,
      cachedPrice: 2.0,
      outputPrice: 28.0,
    },
    // 目录里没有的模型：必须被丢掉，不能进快照
    { id: '999', modelName: 'Some-Unknown-Model-XYZ', brand: 'DeepSeek', inputPrice: 1, cachedPrice: 0, outputPrice: 1 },
    // 我们不认识的品牌：同样丢掉
    { id: '998', modelName: 'Mystery-Model', brand: '某未知厂商', inputPrice: 1, cachedPrice: 0, outputPrice: 1 },
  ],
};

describe('国家超算互联网解析', () => {
  it('把中英文品牌映射到我们的供应商 id', () => {
    expect(SCNET_BRANDS['月之暗面']).toBe('kimi');
    expect(SCNET_BRANDS['智谱ai']).toBe('zhipu');
    expect(SCNET_BRANDS.deepseek).toBe('deepseek');
    expect(SCNET_BRANDS.qwen).toBe('qwen');
  });

  it('按供应商分组产出结果，币种固定为人民币', () => {
    const results = parseScnetPricing(SCNET_FIXTURE);
    const byProvider = Object.fromEntries(results.map((item) => [item.provider, item]));
    expect(Object.keys(byProvider).sort()).toEqual(['deepseek', 'kimi', 'qwen', 'zhipu']);
    for (const result of results) {
      expect(result.sourceUrl).toBe(SCNET_PRICING_URL);
      for (const price of result.prices) expect(price.currency).toBe('CNY');
    }
  });

  it('平台模型名映射到目录模型 id（别名优先）', () => {
    const results = parseScnetPricing(SCNET_FIXTURE);
    const deepseek = results.find((item) => item.provider === 'deepseek');
    expect(deepseek?.prices[0].model).toBe('DeepSeek-V4.1-Flash');
    expect(deepseek?.prices[0].catalogModel).toBe('deepseek-flash');

    const qwen = results.find((item) => item.provider === 'qwen');
    expect(qwen?.prices[0].catalogModel).toBe('qwen3.8-omni-flash');
  });

  it('字符串价格被解析成数字', () => {
    const withStrings = {
      code: '0',
      data: [{ modelName: 'GLM-5.3', brand: '智谱AI', inputPrice: '8.00000000', cachedPrice: '2.00000000', outputPrice: '28.00000000' }],
    };
    const results = parseScnetPricing(withStrings);
    expect(results[0].prices[0].peak.input).toBe(8);
    expect(results[0].prices[0].peak.output).toBe(28);
    expect(results[0].prices[0].peak.cacheRead).toBe(2);
  });

  it('平台不分峰谷，两档同价', () => {
    const results = parseScnetPricing(SCNET_FIXTURE);
    for (const result of results) {
      for (const price of result.prices) expect(price.peak).toEqual(price.offpeak);
    }
  });

  it('丢弃目录里没有的模型与不认识的品牌', () => {
    const results = parseScnetPricing(SCNET_FIXTURE);
    const allModels = results.flatMap((item) => item.prices.map((price) => price.model));
    expect(allModels).not.toContain('Some-Unknown-Model-XYZ');
    expect(allModels).not.toContain('Mystery-Model');
  });

  it('空数据 / 畸形响应不抛异常，返回空数组', () => {
    expect(parseScnetPricing(null)).toEqual([]);
    expect(parseScnetPricing({})).toEqual([]);
    expect(parseScnetPricing({ data: 'not-an-array' })).toEqual([]);
    expect(parseScnetPricing({ data: [] })).toEqual([]);
  });

  it('价格为 0 的条目被跳过（避免用 0 价计费）', () => {
    const zero = { code: '0', data: [{ modelName: 'GLM-5.3', brand: '智谱AI', inputPrice: 0, cachedPrice: 0, outputPrice: 0 }] };
    expect(parseScnetPricing(zero)).toEqual([]);
  });

  it('别名指向其他供应商时不误用', () => {
    // 别名表里的 kimi-k3 在 kimi 目录下存在，故正常返回
    expect(matchScnetModel('kimi', 'Kimi-K3')).toBe('kimi-k3');
    // 供应商不存在时返回 undefined
    expect(matchScnetModel('nonexistent', 'Kimi-K3')).toBeUndefined();
  });
});

/**
 * models.dev 币种与回落测试。
 *
 * 这里的核心风险是**币种判错**：中国版条目是人民币，当成美元再乘汇率会翻 7 倍。
 */
describe('models.dev 币种与回落', () => {
  it('所有条目（含 -cn 中国区）一律是美元', () => {
    // 交叉验证过：minimax-cn/MiniMax-M3 cost 0.3 ×7 = ￥2.1，与官网一致。
    // 若误判成人民币不乘汇率，会少收 7 倍。
    expect(currencyOfModelsDevProvider('alibaba-cn')).toBe('USD');
    expect(currencyOfModelsDevProvider('minimax-cn')).toBe('USD');
    expect(currencyOfModelsDevProvider('moonshotai-cn')).toBe('USD');
    expect(currencyOfModelsDevProvider('openai')).toBe('USD');
    expect(currencyOfModelsDevProvider('zhipuai')).toBe('USD');
  });

  it('国内供应商优先指向中国版条目', () => {
    expect(MODELS_DEV_PROVIDERS.qwen).toBe('alibaba-cn');
    expect(MODELS_DEV_PROVIDERS.minimax).toBe('minimax-cn');
    expect(MODELS_DEV_PROVIDERS.kimi).toBe('moonshotai-cn');
  });

  it('中国版条目缺失时回落到国际版', () => {
    // 只有国际版条目，没有 -cn
    const raw = {
      minimax: {
        models: {
          'MiniMax-M3': { cost: { input: 0.3, output: 1.2, cache_read: 0.06 } },
        },
      },
    };
    const results = parseModelsDev(raw);
    const minimax = results.find((item) => item.provider === 'minimax');
    expect(minimax?.prices.length).toBe(1);
    // 回落到国际版，因此是美元
    expect(minimax?.prices[0].currency).toBe('USD');
    expect(MODELS_DEV_PROVIDERS_FALLBACK.minimax).toBe('minimax');
  });

  it('中国区条目存在时优先用它，且标明是中国区', () => {
    const raw = {
      'minimax-cn': {
        models: { 'MiniMax-M3': { cost: { input: 0.3, output: 1.2, cache_read: 0.06 } } },
      },
      minimax: {
        models: { 'MiniMax-M3': { cost: { input: 9.9, output: 9.9, cache_read: 0 } } },
      },
    };
    const results = parseModelsDev(raw);
    const minimax = results.find((item) => item.provider === 'minimax');
    expect(minimax?.prices[0].currency).toBe('USD');
    expect(minimax?.prices[0].note).toContain('中国区条目');
    // 优先中国区条目：取 0.3 而非国际版的 9.9
    expect(minimax?.prices[0].peak.input).toBe(0.3);
  });

  it('OpenAI 的 GPT-6 系列能被解析出来', () => {
    const raw = {
      openai: {
        models: {
          'gpt-6.1-sol': { cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } },
          'gpt-6-luna': { cost: { input: 0.1, output: 0.5, cache_read: 0.01 } },
          'gpt-6-astra': { cost: { input: 10, output: 50, cache_read: 1 } },
        },
      },
    };
    const results = parseModelsDev(raw);
    const openai = results.find((item) => item.provider === 'openai');
    const models = openai?.prices.map((price) => price.catalogModel) ?? [];
    expect(models).toContain('gpt-6.1-sol');
    expect(models).toContain('gpt-6-luna');
    expect(models).toContain('gpt-6-astra');
  });
});
