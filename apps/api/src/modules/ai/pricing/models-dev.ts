import { ScrapeResult, ScrapedPrice } from './types';
import { findCatalogProvider } from '../model-catalog';

/**
 * models.dev 聚合价目表。
 *
 * 为什么要引入它：我们自己只抓供应商官网，而有三家抓不到——
 *   - OpenAI：官网对我们的出口 IP 返回 Cloudflare 403
 *   - MiniMax：价格由网页脚本动态渲染，HTML 里没有数字
 *   - 豆包：官网返回人机校验页（访问频率限制）
 * 这三家在系统里等于没有价格，界面上也看不出原因。models.dev 是一份公开维护的
 * 聚合价目表（JSON API），正好覆盖它们。
 *
 * 但它只能做**兜底**，不能覆盖官网抓取价，原因有二：
 *   1. 它只有美元价。国内供应商的官方人民币价被换算成美元，换算率与官方原文
 *      不一致（智谱 GLM-5.3 官方 ￥8/￥28，它给 1.4/4.4 美元 ≈ ￥9.8/￥30.8）。
 *   2. 它把峰谷拍平了。DeepSeek 官方分高峰/空闲两档，它只给一个价（≈空闲档），
 *      直接采用会让高峰时段**少收一半**。
 * 因此层级是：用户覆盖价 > 官网抓取价 > models.dev 聚合价 > 预置目录价 > 全局兜底价。
 *
 * 另一个差异：它用 `tiers` 表达**长上下文加价**（超过阈值翻倍），与峰谷是两回事。
 * 我们只取基础档，并把加价阈值写进 note，避免用户误以为超长上下文也是这个价。
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * 我们的供应商 id → models.dev 的供应商 id。
 *
 * 国内厂商在 models.dev 上有**两套条目**：国际版与中国区版（`-cn` 后缀，
 * 表示国内站点入口）。两套的 cost **都是美元**（见 `currencyOfModelsDevProvider`）。
 * 这里优先指向中国区版：它对应厂商国内站点的报价，与国内用户实际付费口径更接近；
 * 中国区版没有可用模型时回落到国际版（见 `MODELS_DEV_PROVIDERS_FALLBACK`）。
 */
export const MODELS_DEV_PROVIDERS: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  zhipu: 'zhipuai',
  kimi: 'moonshotai-cn',
  qwen: 'alibaba-cn',
  doubao: 'volcengine',
  minimax: 'minimax-cn',
};

/**
 * 中国版条目缺失时的回落目标。
 *
 * 中国版比国际版覆盖窄（例如阿里中国版 91 个模型 vs 国际版 59 个，但条目命名
 * 不完全一致），两套都要能取到，否则某个模型会莫名没价格。
 */
export const MODELS_DEV_PROVIDERS_FALLBACK: Record<string, string> = {
  kimi: 'moonshotai',
  qwen: 'alibaba',
  minimax: 'minimax',
};

/** models.dev 的模型条目（只声明用得到的字段）。 */
interface ModelsDevModel {
  id?: string;
  name?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: Array<{ tier?: { type?: string; size?: number } }>;
  };
  status?: string;
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

/** 归一化模型名：小写、去掉分隔符与末尾日期戳，用于跨源匹配。 */
export function normalizeModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_.]/g, '')
    .replace(/\d{6}$/, '')
    .replace(/\d{4,}$/, '');
}

/**
 * 把 models.dev 的模型 id 匹配到我们目录里的模型 id。
 *
 * 两边的命名不总一致：我们写 `GLM-5.3`，它写 `glm-5.3`；我们写
 * `doubao-seed-2.1-pro`，它写 `doubao-seed-2-1-pro-260628`（带日期戳）。
 * 匹配不上就返回 undefined——那表示这是它独有的模型，不必强行塞进目录。
 */
export function matchCatalogModel(provider: string, externalId: string): string | undefined {
  const catalog = findCatalogProvider(provider);
  if (!catalog) return undefined;
  const exact = catalog.models.find((item) => item.model === externalId);
  if (exact) return exact.model;
  const target = normalizeModelName(externalId);
  const normalized = catalog.models.find((item) => normalizeModelName(item.model) === target);
  if (normalized) return normalized.model;
  // 前缀兜底：`doubao-seed-2.0-code` ↔ `doubao-seed-2-0-code-preview-260215`
  const prefix = catalog.models.find((item) => {
    const candidate = normalizeModelName(item.model);
    return candidate.startsWith(target) || target.startsWith(candidate);
  });
  return prefix?.model;
}

/** 该模型是否可用于文本计费（排除嵌入/语音/图像等按别的口径计价的模型）。 */
function isTextPriced(model: ModelsDevModel): boolean {
  const output = model.modalities?.output ?? [];
  if (output.length && !output.includes('text')) return false;
  return true;
}

/**
 * models.dev 的 cost **一律是美元**，`*-cn` 条目也不例外。
 *
 * `-cn` 后缀表示「中国区站点」（同一个模型的国内入口），**不是**人民币计价。
 * 这一点用官网价交叉验证过：
 *   - `minimax-cn/MiniMax-M3` cost = 0.3/1.2 → ×7 = ￥2.1/￥8.4，与官网一致
 *   - `moonshotai-cn/kimi-k3` cost = 3/15   → ×7 = ￥21/￥105，与官网 ￥20/￥100 一致
 *   - `alibaba-cn/qwen3.8-max` cost = 1.78/5.33 → ×7 = ￥12.4/￥37.3，与刊例 ￥12/￥36 一致
 * 若误判成人民币不再乘汇率，会**少收 7 倍**。因此这里恒为美元。
 */
export function currencyOfModelsDevProvider(_externalId: string): 'CNY' | 'USD' {
  return 'USD';
}

/**
 * 解析一份 models.dev 供应商条目下的模型价格。
 *
 * 抽成独立函数是因为国内厂商要取两套条目（中国版优先、国际版兜底），
 * 两套的解析逻辑必须完全一致，否则兜底路径会产出不同口径的价格。
 */
function parseProviderModels(
  provider: string,
  externalId: string,
  source: ModelsDevProvider,
): ScrapedPrice[] {
  const currency = currencyOfModelsDevProvider(externalId);
  const prices: ScrapedPrice[] = [];

  for (const [modelId, model] of Object.entries(source.models ?? {})) {
    if (!isTextPriced(model)) continue;
    const cost = model.cost;
    if (!cost) continue;
    const input = cost.input ?? 0;
    const output = cost.output ?? 0;
    if (input <= 0 && output <= 0) continue;

    const catalogModel = matchCatalogModel(provider, modelId);
    // 目录里没有的模型不进快照：界面上展示不了，只会白白撑大设置项。
    if (!catalogModel) continue;

    const contextTier = (cost.tiers ?? []).find((tier) => (tier.tier?.size ?? 0) > 0);
    // 中国区条目要标明，否则同一模型出现两个价时用户不知道差别在哪。
    const region = externalId.endsWith('-cn') ? '（中国区条目）' : '';
    const notes: string[] = [`聚合价（models.dev），美元${region}`];
    if (contextTier?.tier?.size) {
      notes.push(`上下文超过 ${Math.round(contextTier.tier.size / 1000)}k 时价格上调，此处为基础档`);
    }
    if (model.status === 'deprecated') notes.push('该模型已标记为废弃');

    const tier = {
      input,
      output,
      cacheWrite: cost.cache_write ?? input,
      cacheRead: cost.cache_read ?? 0,
    };
    prices.push({
      model: modelId,
      catalogModel,
      currency,
      // 聚合表不分峰谷，两档同价；官网抓取价（若有）会覆盖它。
      peak: { ...tier },
      offpeak: { ...tier },
      note: notes.join('；'),
    });
  }
  return prices;
}

/**
 * 解析 models.dev 的 api.json，产出我们认识的供应商的价目。
 *
 * 只保留目录里存在的模型：这份聚合表有 200+ 家、上万条记录，全量塞进设置项
 * 会让加密设置膨胀到几 MB，而其中绝大多数我们用不到。
 */
export function parseModelsDev(raw: unknown, fetchedAt = new Date().toISOString()): ScrapeResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const root = raw as Record<string, ModelsDevProvider>;
  const results: ScrapeResult[] = [];

  for (const [provider, externalId] of Object.entries(MODELS_DEV_PROVIDERS)) {
    let prices = parseProviderModels(provider, externalId, root[externalId] ?? {});

    // 中国版条目没有可用模型时回落到国际版：两套条目命名不完全一致，
    // 只认一套会让某些模型（尤其新发布的）莫名没有价格。
    if (!prices.length) {
      const fallbackId = MODELS_DEV_PROVIDERS_FALLBACK[provider];
      if (fallbackId && root[fallbackId]) {
        prices = parseProviderModels(provider, fallbackId, root[fallbackId]);
      }
    }

    if (prices.length) {
      results.push({ provider, sourceUrl: MODELS_DEV_URL, fetchedAt, prices });
    }
  }

  return results;
}
