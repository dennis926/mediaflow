import { AiCompletionRequest, AiCompletionResult, AiProvider } from '../ai.types';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek 按"缓存命中/未命中"分段计价，这两项决定实际花费 */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    /** Anthropic 原生协议的缓存写入计费字段 */
    cache_creation_input_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
  model?: string;
}

export interface DeepSeekProviderOptions {
  apiKey: string;
  /** 供应商标识（deepseek / openai / anthropic …），用于用量归属与按模型计价 */
  providerId?: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** 供应商代码 → 中文名，报错里要说「哪个供应商」而不是把代码甩给用户。 */
const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Claude',
  google: 'Gemini',
  zhipu: '智谱 GLM',
  kimi: 'Kimi',
  doubao: '豆包',
  qwen: '通义千问',
  minimax: 'MiniMax',
  xai: 'xAI',
  mock: '离线占位',
};

/**
 * 把供应商的 HTTP 报错翻译成「能照着做」的提示。
 *
 * 背景：服务器部署在香港，OpenAI / Claude / Gemini 官方接口对香港 IP 直接返回 403
 * （错误码 unsupported_country_region_territory）。此时 Key 是对的、网络是通的，
 * 但把英文原文抛给用户毫无帮助——实测用户看到的就是一句
 * "Country, region, or territory not supported"，既不知道是地区问题也不知道该怎么办。
 * 401（Key 无效）与 403（地域封锁）必须区分清楚，否则会误导用户反复重填 Key。
 */
function explainHttpError(providerId: string, status: number, raw: string): string {
  const label = PROVIDER_LABELS[providerId] ?? providerId;
  if (status === 401 || status === 403) {
    // OpenAI/Anthropic 措辞不同，统一按"地域"判断：只有这两种文案才是地域封锁
    const regionBlocked = /country|region|territory|not allowed|unsupported_country/i.test(raw);
    if (regionBlocked) {
      return (
        `${label} 拒绝了本服务器的请求：出口 IP 所在地区不在该供应商的服务范围内。` +
        `这不是 Key 填错了，换 Key 也无效。可行做法：改用国内供应商（DeepSeek / 智谱 / Kimi / 豆包 / 通义千问），` +
        `或改用支持该模型的第三方中转服务（把接口地址与 Key 换成中转商的即可）。`
      );
    }
    return `${label} 鉴权失败（HTTP ${status}）：请检查 API Key 是否正确、是否已过期、账户余额是否充足。${raw ? ` 供应商原始提示：${raw.slice(0, 160)}` : ''}`;
  }
  if (status === 404) {
    return `${label} 接口地址或模型标识不存在（HTTP 404）：请检查接口地址是否填全（需带 /v1），以及模型名称是否正确。${raw ? ` 供应商原始提示：${raw.slice(0, 160)}` : ''}`;
  }
  if (status === 429) {
    return `${label} 拒绝了请求（HTTP 429）：通常是调用频率或额度超限，请稍后重试或检查账户额度。`;
  }
  if (status >= 500) {
    return `${label} 服务端异常（HTTP ${status}）：供应商自身故障，请稍后重试。`;
  }
  return `${label} 接口返回 HTTP ${status}：${raw.slice(0, 200) || '未知错误'}`;
  // 说明：401/404 分支保留上游原文，避免排障时丢掉 "Invalid token" 这类关键细节。
}

export class DeepSeekProvider implements AiProvider {
  /** 对外暴露的是"配置里的供应商"，而不是底层使用的兼容协议实现 */
  readonly name: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  /** 中文供应商名，用于报错文案 */
  private readonly label: string;

  constructor(options: DeepSeekProviderOptions) {
    this.name = options.providerId ?? 'deepseek';
    this.label = PROVIDER_LABELS[this.name] ?? this.name;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /**
   * 拉取该供应商的可用模型列表（OpenAI 兼容的 GET /models）。
   *
   * 用于「AI 配置」里的「测试连接 → 获取模型」：连上之后直接把模型列出来给用户勾选，
   * 不让用户凭记忆手打模型标识（打错了要到调用时才报错，很难查）。
   */
  async listModels(): Promise<string[]> {
    if (!this.apiKey) throw new Error(`未配置 ${this.label} 的 API Key，无法获取模型列表`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(explainHttpError(this.name, response.status, text));
      }
      const parsed = JSON.parse(text) as { data?: Array<{ id?: string }> };
      const ids = (parsed.data ?? [])
        .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
        .filter(Boolean);
      return [...new Set(ids)].sort();
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.apiKey) throw new Error(`未配置 ${this.label} 的 API Key，无法调用接口`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          temperature: request.temperature ?? 0.7,
          // Reasoning models (deepseek-flash) spend tokens on thinking first, so the
          // budget must leave room for the answer; JSON answers need the most.
          max_tokens: request.maxTokens ?? (request.json ? 4096 : 2048),
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
      if (!response.ok) {
        throw new Error(explainHttpError(this.name, response.status, payload.error?.message ?? ''));
      }
      const choice = payload.choices?.[0];
      const text = choice?.message?.content;
      if (!text) {
        const truncated = choice?.finish_reason === 'length';
        const thought = (choice?.message?.reasoning_content ?? '').length;
        throw new Error(
          truncated
            ? `${this.label} 只返回了思考过程（${thought} 字）就被 max_tokens 截断，未产出正文：请提高最大输出长度后重试`
            : `${this.label} 未返回内容`,
        );
      }

      return {
        text,
        model: payload.model ?? this.model,
        tokensInput: payload.usage?.prompt_tokens ?? 0,
        tokensOutput: payload.usage?.completion_tokens ?? 0,
        tokensCached: payload.usage?.prompt_cache_hit_tokens ?? payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        tokensCacheWrite: payload.usage?.cache_creation_input_tokens ?? payload.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
        tokensReasoning: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        finishReason: choice?.finish_reason ?? undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
