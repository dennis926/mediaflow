/**
 * 模型价目表（预置参考价）。
 *
 * 设计说明：
 * - 只作为**开箱默认值**：真实价格以各供应商官网为准（官方价会调整），所以每条模型价格都可以在
 *   「AI 用量」里改，也可以让系统**自动抓取官网**覆盖（AI_OFFICIAL_PRICES，见 pricing/ 目录）。
 * - 计价单位有两种：
 *     1. 美元价（officialUsd）：多数海外供应商按美元报价，按汇率（AI_USD_CNY_RATE，默认 7）折算人民币，不设任何折扣。
 *     2. 人民币价（officialCny）：国内供应商直接以人民币报价，**且可能分峰谷两档**（DeepSeek 即是）。
 *   两条路径最终都归一成人民币的「峰谷价目表」参与计费。
 * - 四个计费维度与主流中转站一致：输入 / 输出 / 缓存写入（首次写缓存）/ 缓存读取（命中缓存）。
 *   供应商不报的维度记 0 用量，价格保持默认即可。
 */

/** 美元 → 人民币汇率默认值（可在「设置 → AI 服务」调整）。 */
export const DEFAULT_USD_CNY_RATE = 7;

export interface ModelPriceUsd {
  /** 输入（未命中缓存） */
  input: number;
  output: number;
  /** 缓存写入（Anthropic 的 cache write 会额外计费；其他供应商通常为 0） */
  cacheWrite: number;
  /** 缓存读取（命中缓存） */
  cacheRead: number;
}

/** 人民币三段价（供应商官方口径：缓存命中/未命中的输入分开报价）。 */
export interface ModelPriceCnyTier {
  /** 输入（未命中缓存） */
  input: number;
  output: number;
  /** 输入（命中缓存） */
  cacheRead: number;
}

/**
 * 人民币峰谷价目（国内供应商常见）。
 * 不分峰谷的供应商把两档填成同一个值即可。
 */
export interface ModelPriceCnyTiered {
  peak: ModelPriceCnyTier;
  offpeak: ModelPriceCnyTier;
}

export interface CatalogModel {
  model: string;
  label: string;
  /** 海外供应商：官方美元价（按汇率折算） */
  officialUsd?: ModelPriceUsd;
  /** 国内供应商：官方人民币价（可含峰谷） */
  officialCny?: ModelPriceCnyTiered;
  /** 预置参考价标记：true 表示数值来自公开资料、可能滞后，界面上提示可编辑 */
  reference?: boolean;
  note?: string;
}

export interface CatalogProvider {
  provider: string;
  label: string;
  /** OpenAI 兼容接口的默认地址（多数国内供应商都提供） */
  defaultBaseUrl: string;
  /** 是否走 Anthropic 原生协议（需要不同的请求体） */
  protocol: 'openai-compatible' | 'anthropic';
  models: CatalogModel[];
}

/**
 * 预置供应商与模型。
 *
 * DeepSeek 的价格直接取自官网「模型 & 价格」页（人民币、分峰谷两档，2026-10 抓取）；
 * 其余海外供应商为美元参考价。系统可自动抓取官网刷新 DeepSeek 价格。
 */
export const DEFAULT_MODEL_CATALOG: CatalogProvider[] = [
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai-compatible',
    models: [
      {
        model: 'deepseek-flash',
        label: 'DeepSeek V4.1 Flash',
        officialCny: {
          peak: { input: 2, output: 8, cacheRead: 0.04 },
          offpeak: { input: 1, output: 4, cacheRead: 0.02 },
        },
        reference: true,
        note: '高峰=工作日 9:00-12:00、14:00-18:00（北京时间），其余为空闲；思考 token 计入输出',
      },
      {
        model: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        officialCny: {
          peak: { input: 9, output: 27, cacheRead: 0.3 },
          offpeak: { input: 4.5, output: 13.5, cacheRead: 0.15 },
        },
        reference: true,
        note: '高峰=工作日 9:00-12:00、14:00-18:00（北京时间），其余为空闲',
      },
    ],
  },
  {
    provider: 'openai',
    label: 'ChatGPT / OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'gpt-6.1-sol', label: 'GPT-6.1 SOL', officialUsd: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }, reference: true, note: '上下文超过 272k token 时翻倍（输入 $4 / 输出 $15）' },
      { model: 'gpt-6-sol', label: 'GPT-6 SOL', officialUsd: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }, reference: true, note: '上下文超过 272k token 时翻倍（输入 $4 / 输出 $15）' },
      { model: 'gpt-6-luna', label: 'GPT-6 Luna', officialUsd: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 }, reference: true, note: '上下文超过 272k token 时翻倍（输入 $0.2 / 输出 $0.75）' },
      { model: 'gpt-6-astra', label: 'GPT-6 Astra', officialUsd: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }, reference: true, note: '上下文超过 272k token 时翻倍（输入 $20 / 输出 $75）' },
      { model: 'gpt-5.5', label: 'GPT-5.5', officialUsd: { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 }, reference: true, note: '上下文超过 272k token 时翻倍' },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6 SOL', officialUsd: { input: 4, output: 20, cacheWrite: 0, cacheRead: 0.4 }, reference: true, note: '上下文超过 272k token 时翻倍' },
      { model: 'gpt-5-mini', label: 'GPT-5 mini', officialUsd: { input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 }, reference: true },
    ],
  },
  {
    provider: 'anthropic',
    label: 'Claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    models: [
      { model: 'claude-fable-5-1', label: 'Claude Fable 5.1', officialUsd: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 }, reference: true },
      { model: 'claude-opus-5-5', label: 'Claude Opus 5.5', officialUsd: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }, reference: true },
      { model: 'claude-opus-5', label: 'Claude Opus 5', officialUsd: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }, reference: true },
      { model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', officialUsd: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }, reference: true },
      { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', officialUsd: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }, reference: true },
      { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', officialUsd: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }, reference: true },
    ],
  },
  {
    provider: 'google',
    label: 'Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai-compatible',
    models: [
      { model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', officialUsd: { input: 0.75, output: 3.75, cacheWrite: 0, cacheRead: 0.19 }, reference: true, note: '推广价，2027-01-01 起上调' },
      { model: 'gemini-3.8-flash-cyber', label: 'Gemini 3.8 Flash Cyber', officialUsd: { input: 2.25, output: 11.25, cacheWrite: 0, cacheRead: 0.225 }, reference: true },
      { model: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', officialUsd: { input: 0.75, output: 3.75, cacheWrite: 0, cacheRead: 0.19 }, reference: true },
      { model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', officialUsd: { input: 3, output: 18, cacheWrite: 0, cacheRead: 0.3 }, reference: true },
    ],
  },
  {
    provider: 'zhipu',
    label: '智谱 GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai-compatible',
    models: [
      { model: 'GLM-5.3', label: 'GLM-5.3', officialCny: { peak: { input: 8, output: 28, cacheRead: 2 }, offpeak: { input: 8, output: 28, cacheRead: 2 } }, reference: true },
      { model: 'GLM-5.3-Flash', label: 'GLM-5.3-Flash', officialCny: { peak: { input: 0.8, output: 2.8, cacheRead: 0.23 }, offpeak: { input: 0.8, output: 2.8, cacheRead: 0.23 } }, reference: true },
      { model: 'GLM-5.3-FlashX', label: 'GLM-5.3-FlashX', officialCny: { peak: { input: 2, output: 7, cacheRead: 0.57 }, offpeak: { input: 2, output: 7, cacheRead: 0.57 } }, reference: true },
      { model: 'GLM-5.2', label: 'GLM-5.2', officialCny: { peak: { input: 8, output: 28, cacheRead: 2 }, offpeak: { input: 8, output: 28, cacheRead: 2 } }, reference: true },
      { model: 'GLM-4.7', label: 'GLM-4.7', officialCny: { peak: { input: 2, output: 8, cacheRead: 0.4 }, offpeak: { input: 2, output: 8, cacheRead: 0.4 } }, reference: true },
    ],
  },
  {
    provider: 'kimi',
    label: 'Kimi（月之暗面）',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'kimi-k3', label: 'Kimi K3', officialCny: { peak: { input: 20, output: 100, cacheRead: 2 }, offpeak: { input: 20, output: 100, cacheRead: 2 } }, reference: true, note: '另有缓存写入 ￥20（5min）/￥40（1h）每百万 token' },
      { model: 'kimi-k2.6', label: 'Kimi K2.6', officialCny: { peak: { input: 6.5, output: 27, cacheRead: 1.1 }, offpeak: { input: 6.5, output: 27, cacheRead: 1.1 } }, reference: true },
      { model: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', officialCny: { peak: { input: 6.5, output: 27, cacheRead: 1.3 }, offpeak: { input: 6.5, output: 27, cacheRead: 1.3 } }, reference: true },
      { model: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code 高速版', officialCny: { peak: { input: 13, output: 54, cacheRead: 2.6 }, offpeak: { input: 13, output: 54, cacheRead: 2.6 } }, reference: true },
    ],
  },
  {
    provider: 'doubao',
    label: '豆包（火山引擎）',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'openai-compatible',
    models: [
      { model: 'doubao-seed-evolving', label: '豆包 Seed Evolving', officialCny: { peak: { input: 6, output: 30, cacheRead: 1.2 }, offpeak: { input: 6, output: 30, cacheRead: 1.2 } }, reference: true },
      { model: 'doubao-seed-2.1-pro', label: '豆包 Seed 2.1 Pro', officialCny: { peak: { input: 6, output: 30, cacheRead: 1.2 }, offpeak: { input: 6, output: 30, cacheRead: 1.2 } }, reference: true },
      { model: 'doubao-seed-2.1-lite', label: '豆包 Seed 2.1 Lite', officialCny: { peak: { input: 0.8, output: 2.7, cacheRead: 0.16 }, offpeak: { input: 0.8, output: 2.7, cacheRead: 0.16 } }, reference: true },
      { model: 'doubao-seed-2.1-turbo', label: '豆包 Seed 2.1 Turbo', officialCny: { peak: { input: 3, output: 15, cacheRead: 0.6 }, offpeak: { input: 3, output: 15, cacheRead: 0.6 } }, reference: true },
      { model: 'doubao-seed-2.0-pro', label: '豆包 Seed 2.0 Pro', officialCny: { peak: { input: 3.2, output: 16, cacheRead: 0.64 }, offpeak: { input: 3.2, output: 16, cacheRead: 0.64 } }, reference: true },
      { model: 'doubao-seed-2.0-lite', label: '豆包 Seed 2.0 Lite', officialCny: { peak: { input: 0.6, output: 3.6, cacheRead: 0.12 }, offpeak: { input: 0.6, output: 3.6, cacheRead: 0.12 } }, reference: true },
      { model: 'doubao-seed-2.0-mini', label: '豆包 Seed 2.0 Mini', officialCny: { peak: { input: 0.2, output: 2, cacheRead: 0.04 }, offpeak: { input: 0.2, output: 2, cacheRead: 0.04 } }, reference: true },
      { model: 'doubao-seed-2.0-code', label: '豆包 Seed 2.0 Code', officialCny: { peak: { input: 3.2, output: 16, cacheRead: 0.64 }, offpeak: { input: 3.2, output: 16, cacheRead: 0.64 } }, reference: true },
    ],
  },
  {
    provider: 'qwen',
    label: '通义千问（阿里云百炼）',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'qwen3.8-omni-flash', label: '通义千问 3.8 Omni Flash', officialCny: { peak: { input: 0.8, output: 2.7, cacheRead: 0.1 }, offpeak: { input: 0.8, output: 2.7, cacheRead: 0.1 } }, reference: true },
    ],
  },
  {
    provider: 'minimax',
    label: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'minimax-m3', label: 'MiniMax M3', officialCny: { peak: { input: 2.1, output: 8.4, cacheRead: 0.42 }, offpeak: { input: 2.1, output: 8.4, cacheRead: 0.42 } }, reference: true, note: '官网价格页为 JS 渲染，暂无法自动抓取；数值按 Together 转售价换算参考' },
    ],
  },
  {
    provider: 'xai',
    label: 'Grok（xAI）',
    defaultBaseUrl: 'https://api.x.ai/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'grok-4.7', label: 'Grok 4.7', officialUsd: { input: 2, output: 6, cacheWrite: 0, cacheRead: 0.5 }, reference: true, note: '提示词 ≥200k token 时翻倍' },
      { model: 'grok-4.6', label: 'Grok 4.6', officialUsd: { input: 2, output: 6, cacheWrite: 0, cacheRead: 0.5 }, reference: true, note: '提示词 ≥200k token 时翻倍' },
      { model: 'grok-4.5', label: 'Grok 4.5', officialUsd: { input: 2, output: 6, cacheWrite: 0, cacheRead: 0.3 }, reference: true },
      { model: 'grok-4.3', label: 'Grok 4.3', officialUsd: { input: 1.25, output: 2.5, cacheWrite: 0, cacheRead: 0.2 }, reference: true },
    ],
  },
];

/** 找不到供应商时用它兜底展示（价格需用户自己填）。 */
export const CUSTOM_PROVIDER: CatalogProvider = {
  provider: 'custom',
  label: '自定义供应商',
  defaultBaseUrl: '',
  protocol: 'openai-compatible',
  models: [],
};

export function findCatalogProvider(provider: string): CatalogProvider | undefined {
  return DEFAULT_MODEL_CATALOG.find((item) => item.provider === provider);
}

export function findCatalogModel(provider: string, model: string): CatalogModel | undefined {
  return findCatalogProvider(provider)?.models.find((item) => item.model === model);
}

/** 供应商名称（界面上优先显示中文/常用叫法）。 */
export function providerLabel(provider: string): string {
  return findCatalogProvider(provider)?.label ?? provider;
}

/** 哪些供应商支持从官网自动抓取价格（抓取器实现见 pricing/scrapers.ts）。 */
export const SCRAPABLE_PROVIDERS = [
  'deepseek',
  'zhipu',
  'kimi',
  'xai',
  'anthropic',
  'google',
  'doubao',
  'qwen',
] as const;

export function isScrapable(provider: string): boolean {
  return (SCRAPABLE_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * 明确无法自动抓取的供应商与原因（界面上照实说明，而不是显示成"坏了"）。
 * 官方页面本身对中国香港出口封锁，只能手工改价。
 */
export const UNSCRAPABLE_REASONS: Record<string, string> = {
  openai: '官网对本站出口 IP 返回 403（Cloudflare 拦截），无法直接抓取；已由聚合价目表（models.dev）兜底，含 GPT-6 系列',
  minimax: '官网价格页为纯 JS 渲染（页面不含任何价格数字），无法直接抓取；已由聚合价目表（models.dev 中国版，人民币价）兜底',
};
