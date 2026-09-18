import { AiCompletionRequest, AiCompletionResult, AiProvider } from '../ai.types';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek 按"缓存命中/未命中"分段计价，这两项决定实际花费 */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
  model?: string;
}

export interface DeepSeekProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

export class DeepSeekProvider implements AiProvider {
  readonly name = 'deepseek';
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;

  constructor(options: DeepSeekProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
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
        tokensReasoning: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
