/**
 * 模型价目表（预置参考价）。
 *
 * 设计说明：
 * - 只作为**开箱默认值**：真实价格以各供应商官网为准（官方价会调整），所以每条模型价格都可以在
 *   「AI 用量」里改（改后写入数据库覆盖层 AI_MODEL_PRICES，不影响代码）。
 * - 价格单位统一为**美元 / 百万 token**（官方价），折算人民币时乘汇率（AI_USD_CNY_RATE，默认 7），不设任何折扣。
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

export interface CatalogModel {
  model: string;
  label: string;
  officialUsd: ModelPriceUsd;
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

/** 预置供应商与模型（价格均为美元/百万 token，可编辑） */
export const DEFAULT_MODEL_CATALOG: CatalogProvider[] = [
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'deepseek-flash', label: 'DeepSeek Flash', officialUsd: { input: 0.28, output: 0.42, cacheWrite: 0, cacheRead: 0.028 }, reference: true, note: '推理模型，思考 token 计入输出' },
      { model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', officialUsd: { input: 0.55, output: 2.19, cacheWrite: 0, cacheRead: 0.055 }, reference: true },
    ],
  },
  {
    provider: 'openai',
    label: 'ChatGPT / OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'gpt-5.5', label: 'GPT-5.5', officialUsd: { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 }, reference: true },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6 SOL', officialUsd: { input: 2.5, output: 20, cacheWrite: 0, cacheRead: 0.25 }, reference: true },
      { model: 'gpt-5-mini', label: 'GPT-5 mini', officialUsd: { input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 }, reference: true },
    ],
  },
  {
    provider: 'anthropic',
    label: 'Claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    models: [
      { model: 'claude-opus-5', label: 'Claude Opus 5', officialUsd: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }, reference: true },
      { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', officialUsd: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }, reference: true },
    ],
  },
  {
    provider: 'google',
    label: 'Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai-compatible',
    models: [
      { model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', officialUsd: { input: 0.75, output: 3, cacheWrite: 0, cacheRead: 0.19 }, reference: true },
      { model: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', officialUsd: { input: 1.25, output: 5, cacheWrite: 0, cacheRead: 0.31 }, reference: true },
    ],
  },
  {
    provider: 'zhipu',
    label: '智谱 GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai-compatible',
    models: [
      { model: 'glm-4.6', label: 'GLM-4.6', officialUsd: { input: 0.6, output: 2.2, cacheWrite: 0, cacheRead: 0.11 }, reference: true },
      { model: 'glm-4.6-flash', label: 'GLM-4.6 Flash', officialUsd: { input: 0.1, output: 0.4, cacheWrite: 0, cacheRead: 0.02 }, reference: true },
    ],
  },
  {
    provider: 'kimi',
    label: 'Kimi（月之暗面）',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'kimi-k2-turbo', label: 'Kimi K2 Turbo', officialUsd: { input: 0.6, output: 2.5, cacheWrite: 0, cacheRead: 0.15 }, reference: true },
    ],
  },
  {
    provider: 'minimax',
    label: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'minimax-m2', label: 'MiniMax M2', officialUsd: { input: 0.3, output: 1.2, cacheWrite: 0, cacheRead: 0.06 }, reference: true },
    ],
  },
  {
    provider: 'xai',
    label: 'Grok（xAI）',
    defaultBaseUrl: 'https://api.x.ai/v1',
    protocol: 'openai-compatible',
    models: [
      { model: 'grok-4', label: 'Grok 4', officialUsd: { input: 3, output: 15, cacheWrite: 0, cacheRead: 0.75 }, reference: true },
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
