/**
 * 国家超算互联网（SCNet）模型价格抓取器 —— 国内权威价目来源。
 *
 * 为什么选它：它是科技部指导、多部委联合推进的**国家级**算力平台，公开列出
 * 主流国产大模型的 API 刊例价（人民币 / 百万 token），页面数据由公开 JSON 接口
 * 直接提供，不依赖 JS 渲染，也不需要密钥。相比各家厂商官网，它的优势是**一处
 * 横向可比**；相比第三方聚合站，它的优势是**权威性**（国家级平台，价格即其销售价）。
 *
 * 定位：国内权威**参考价**，不是厂商官网价。
 *   - 它是平台转售口径，可能含限时优惠，也可能略高于厂商官网直销价；
 *   - 页面明确「暂不支持闲忙时定价」，因此**没有峰谷两档**（两档同价）。
 * 所以它排在官网抓取价之后：厂商官网能抓到时用官网价（更准、且分峰谷），
 * 抓不到时用它的价兜底，好过没有价格或只剩美元换算价。
 *
 * 反爬说明：该接口无需登录即可读，但只返回平台首页展示的模型（当前 4 个）；
 * 全量清单需登录控制台。这是已知边界，界面照实说明，不假装能抓全。
 */

import { ScrapeResult, ScrapedPrice } from './types';
import { findCatalogProvider } from '../model-catalog';
import { normalizeModelName } from './models-dev';

export const SCNET_PRICING_URL = 'https://www.scnet.cn/acx/llm/api/console/model/landing';

/** 界面上展示的来源名。 */
export const SCNET_SOURCE_LABEL = '国家超算互联网';

/**
 * 平台给的品牌名 → 我们的供应商 id。
 *
 * 它用中文品牌（月之暗面、智谱AI），我们用英文 id（kimi、zhipu），必须显式映射，
 * 否则整批模型会因为"供应商不认识"被静默丢弃。
 */
export const SCNET_BRANDS: Record<string, string> = {
  deepseek: 'deepseek',
  月之暗面: 'kimi',
  moonshot: 'kimi',
  qwen: 'qwen',
  通义: 'qwen',
  阿里: 'qwen',
  智谱ai: 'zhipu',
  智谱: 'zhipu',
  zhipu: 'zhipu',
  minimax: 'minimax',
};

/**
 * 平台模型名 → 我们目录的模型 id。
 *
 * 两边的命名差异比 models.dev 更大：平台写 `DeepSeek-V4.1-Flash`，我们目录写
 * `deepseek-flash`；平台写 `Qwen3.8-Flash`，我们目录写 `qwen3.8-omni-flash`。
 * 规范化匹配（去分隔符、去日期戳）救不了这种差异，只能显式列别名；
 * 别名没覆盖到的再走规范化兜底。
 */
export const SCNET_MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-flash-0731': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'qwen3.8-flash': 'qwen3.8-omni-flash',
  'glm-5.3': 'GLM-5.3',
  'kimi-k3': 'kimi-k3',
  'minimax-m3': 'minimax-m3',
};

/** 平台接口返回的一条模型记录（只声明用得到的字段）。 */
interface ScnetModel {
  modelName?: string;
  brand?: string;
  inputPrice?: number | string;
  cachedPrice?: number | string;
  outputPrice?: number | string;
  description?: string;
}

interface ScnetResponse {
  code?: string | number;
  msg?: string;
  data?: ScnetModel[];
}

/** 把平台模型名解析成我们目录里的模型 id；解析不出返回 undefined。 */
export function matchScnetModel(provider: string, platformName: string): string | undefined {
  const alias = SCNET_MODEL_ALIASES[platformName.toLowerCase()];
  if (alias) {
    // 别名可能指向另一个供应商的模型，必须校验它确实在该供应商目录下。
    const catalog = findCatalogProvider(provider);
    if (catalog?.models.some((item) => item.model === alias)) return alias;
  }
  const catalog = findCatalogProvider(provider);
  if (!catalog) return undefined;
  const target = normalizeModelName(platformName);
  const normalized = catalog.models.find((item) => normalizeModelName(item.model) === target);
  if (normalized) return normalized.model;
  const prefix = catalog.models.find((item) => {
    const candidate = normalizeModelName(item.model);
    return candidate.startsWith(target) || target.startsWith(candidate);
  });
  return prefix?.model;
}

/** 解析数值；接口用字符串传数字（`"2.00000000"`），直接 Number 会得到 NaN。 */
function num(value: number | string | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * 解析国家超算的价格接口。
 *
 * 只保留目录里存在的模型：这份清单是平台全量商品，含大量我们没接入的模型，
 * 全量入库只会撑大设置项、并在界面上出现一堆用不到的条目。
 * 平台不分峰谷，两档填同一个值（计费路径因此无需分支）。
 */
export function parseScnetPricing(raw: unknown, fetchedAt = new Date().toISOString()): ScrapeResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const response = raw as ScnetResponse;
  if (!Array.isArray(response.data)) return [];

  // 按供应商归集：一次响应里混着多家厂商，要先分组再产出结果。
  const grouped = new Map<string, ScrapedPrice[]>();

  for (const item of response.data) {
    const platformName = (item.modelName ?? '').trim();
    if (!platformName) continue;
    const provider = SCNET_BRANDS[(item.brand ?? '').trim().toLowerCase()];
    if (!provider) continue;

    const input = num(item.inputPrice);
    const output = num(item.outputPrice);
    // 缓存输入价平台单独报；为 0 时按 0 处理（表示该模型不区分缓存计费）。
    const cacheRead = num(item.cachedPrice);
    if (input <= 0 && output <= 0) continue;

    const catalogModel = matchScnetModel(provider, platformName);
    if (!catalogModel) continue;

    const note = '国家超算互联网刊例价（人民币）；该平台不分峰谷，两档同价';
    const tier = { input, output, cacheRead };
    const prices = grouped.get(provider) ?? [];
    prices.push({
      model: platformName,
      catalogModel,
      currency: 'CNY',
      peak: { ...tier },
      offpeak: { ...tier },
      note,
    });
    grouped.set(provider, prices);
  }

  return [...grouped.entries()].map(([provider, prices]) => ({
    provider,
    sourceUrl: SCNET_PRICING_URL,
    fetchedAt,
    prices,
  }));
}
