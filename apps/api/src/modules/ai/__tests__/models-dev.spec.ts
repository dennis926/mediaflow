import { describe, expect, it } from 'vitest';
import {
  MODELS_DEV_PROVIDERS,
  MODELS_DEV_URL,
  matchCatalogModel,
  normalizeModelName,
  parseModelsDev,
} from '../pricing/models-dev';

/**
 * 聚合价目表（models.dev）解析。
 *
 * 这组用例守两件事：
 *   1. 它必须补上官网抓不到的三家（OpenAI / MiniMax / 豆包），否则引入它就没意义；
 *   2. 它**不能**污染官网价——本文件只测解析，优先级由 model-pricing 的用例守。
 */

/** 结构取自 https://models.dev/api.json 的真实片段（只保留用得到的字段）。 */
const FIXTURE = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-5-mini': {
        id: 'gpt-5-mini',
        name: 'GPT-5 mini',
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 400000 },
        cost: { input: 0.25, output: 2, cache_read: 0.025 },
      },
      // 长上下文加价：基础档 5/30，超过 272k 翻倍
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1050000 },
        cost: {
          input: 5,
          output: 30,
          cache_read: 0.5,
          tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272000 } }],
        },
      },
      // 非文本输出：不该进文本计费价目
      'gpt-image-1': {
        id: 'gpt-image-1',
        name: 'GPT Image 1',
        modalities: { input: ['text'], output: ['image'] },
        cost: { input: 5, output: 0 },
      },
      // 目录里没有的模型：不该进快照（只会撑大设置项）
      'gpt-9-unknown': {
        id: 'gpt-9-unknown',
        name: 'GPT-9',
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 1, output: 2 },
      },
    },
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    models: {
      'MiniMax-M3': {
        id: 'MiniMax-M3',
        name: 'MiniMax M3',
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
      },
    },
  },
  volcengine: {
    id: 'volcengine',
    name: 'Volcengine Ark',
    models: {
      // 带日期戳：靠规范化匹配到目录里的 doubao-seed-2.1-pro
      'doubao-seed-2-1-pro-260628': {
        id: 'doubao-seed-2-1-pro-260628',
        name: 'Doubao Seed 2.1 Pro',
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.8906, output: 4.45301, cache_read: 0.17812 },
      },
      'doubao-seed-2-0-code-preview-260215': {
        id: 'doubao-seed-2-0-code-preview-260215',
        name: 'Doubao Seed 2.0 Code',
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.47499, output: 2.37494 },
      },
    },
  },
  // 与我们无关的供应商：不该出现在结果里
  'some-other-vendor': {
    id: 'some-other-vendor',
    name: 'Other',
    models: {
      'whatever': { id: 'whatever', modalities: { output: ['text'] }, cost: { input: 1, output: 1 } },
    },
  },
};

describe('聚合价目表：模型名匹配', () => {
  it('归一化去掉分隔符与末尾日期戳', () => {
    expect(normalizeModelName('doubao-seed-2-1-pro-260628')).toBe('doubaoseed21pro');
    expect(normalizeModelName('GLM-5.3')).toBe('glm53');
    expect(normalizeModelName('MiniMax-M3')).toBe('minimaxm3');
  });

  it('精确、规范化、前缀三层都能匹配到目录模型', () => {
    expect(matchCatalogModel('openai', 'gpt-5-mini')).toBe('gpt-5-mini');
    // 我们写 GLM-5.3，聚合表写 glm-5.3
    expect(matchCatalogModel('zhipu', 'glm-5.3')).toBe('GLM-5.3');
    // 聚合表带日期戳，目录不带
    expect(matchCatalogModel('doubao', 'doubao-seed-2-1-pro-260628')).toBe('doubao-seed-2.1-pro');
    // 前缀兜底：目录 doubao-seed-2.0-code ↔ 聚合表 ...-code-preview-260215
    expect(matchCatalogModel('doubao', 'doubao-seed-2-0-code-preview-260215')).toBe('doubao-seed-2.0-code');
    // 目录里没有的模型返回 undefined
    expect(matchCatalogModel('openai', 'gpt-9-unknown')).toBeUndefined();
  });
});

describe('聚合价目表：解析', () => {
  const results = parseModelsDev(FIXTURE, '2026-10-02T00:00:00.000Z');

  it('覆盖官网抓不到的三家供应商（结果用我们的 provider id 作键）', () => {
    const providers = results.map((item) => item.provider).sort();
    // 注意是 doubao 而不是 models.dev 那边的 volcengine——快照按我们的 id 索引，
    // 否则计费侧按 provider 取价会取不到。
    expect(providers).toEqual(['doubao', 'minimax', 'openai']);
  });

  it('全部标记为美元（美元价 × 汇率在解析层之后做）', () => {
    for (const result of results) {
      for (const price of result.prices) {
        expect(price.currency).toBe('USD');
      }
    }
  });

  it('两档同价：聚合表不分峰谷，不会伪造出高峰价', () => {
    const minimax = results.find((item) => item.provider === 'minimax');
    const price = minimax?.prices[0];
    expect(price?.peak).toEqual(price?.offpeak);
  });

  it('跳过非文本输出的模型（图像模型不按 token 计价）', () => {
    const openai = results.find((item) => item.provider === 'openai');
    const models = openai?.prices.map((price) => price.model) ?? [];
    expect(models).not.toContain('gpt-image-1');
  });

  it('跳过目录里没有的模型（避免撑大加密设置项）', () => {
    const openai = results.find((item) => item.provider === 'openai');
    const models = openai?.prices.map((price) => price.model) ?? [];
    expect(models).not.toContain('gpt-9-unknown');
  });

  it('无关供应商不进结果', () => {
    expect(results.find((item) => item.provider === 'some-other-vendor')).toBeUndefined();
  });

  it('长上下文加价写进 note，基础档取基础价', () => {
    const openai = results.find((item) => item.provider === 'openai');
    const gpt55 = openai?.prices.find((price) => price.model === 'gpt-5.5');
    // 基础档是 5/30，不是翻倍后的 10/45
    expect(gpt55?.peak.input).toBe(5);
    expect(gpt55?.peak.output).toBe(30);
    expect(gpt55?.note).toContain('272k');
  });

  it('缓存写入缺省按输入价兜底（不是 0）', () => {
    const minimax = results.find((item) => item.provider === 'minimax');
    expect(minimax?.prices[0].peak.cacheWrite).toBe(0.3);
  });

  it('模型 id 匹配结果写进 catalogModel，供计费侧反查', () => {
    const volc = results.find((item) => item.provider === 'doubao');
    const pro = volc?.prices.find((price) => price.model === 'doubao-seed-2-1-pro-260628');
    expect(pro?.catalogModel).toBe('doubao-seed-2.1-pro');
  });

  it('来源地址固定为 models.dev 的 JSON 接口', () => {
    for (const result of results) {
      expect(result.sourceUrl).toBe(MODELS_DEV_URL);
      expect(result.fetchedAt).toBe('2026-10-02T00:00:00.000Z');
    }
  });

  it('非法输入返回空数组而不抛异常', () => {
    expect(parseModelsDev(null)).toEqual([]);
    expect(parseModelsDev('not json')).toEqual([]);
    expect(parseModelsDev({})).toEqual([]);
  });
});

describe('聚合价目表：供应商映射', () => {
  it('每家都映射到 models.dev 的供应商 id', () => {
    expect(MODELS_DEV_PROVIDERS.openai).toBe('openai');
    // 智谱在 models.dev 叫 zhipuai，Kimi 叫 moonshotai，千问叫 alibaba
    expect(MODELS_DEV_PROVIDERS.zhipu).toBe('zhipuai');
    expect(MODELS_DEV_PROVIDERS.kimi).toBe('moonshotai');
    expect(MODELS_DEV_PROVIDERS.qwen).toBe('alibaba');
    expect(MODELS_DEV_PROVIDERS.doubao).toBe('volcengine');
  });
});
