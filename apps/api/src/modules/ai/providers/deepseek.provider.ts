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

export class DeepSeekProvider implements AiProvider {
  /** 对外暴露的是"配置里的供应商"，而不是底层使用的兼容协议实现 */
  readonly name: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;

  constructor(options: DeepSeekProviderOptions) {
    this.name = options.providerId ?? 'deepseek';
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
    if (!this.apiKey) throw new Error('未配置 API Key，无法获取模型列表');
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
        throw new Error(`获取模型列表失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
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
    if (!this.apiKey) throw new Error('未配置 AI_API_KEY，无法调用 DeepSeek 接口');

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

      const payload = (await response.json()) as ChatCompletionResponse;
      if (!response.ok) {
        throw new Error(`DeepSeek 接口返回 HTTP ${response.status}：${payload.error?.message ?? '未知错误'}`);
      }
      const choice = payload.choices?.[0];
      const text = choice?.message?.content;
      if (!text) {
        const truncated = choice?.finish_reason === 'length';
        const thought = (choice?.message?.reasoning_content ?? '').length;
        throw new Error(
          truncated
            ? `DeepSeek 只返回了思考过程（${thought} 字）就被 max_tokens 截断，未产出正文：请提高最大输出长度后重试`
            : 'DeepSeek 未返回内容',
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
