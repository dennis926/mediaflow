import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from './ai.types';
import { DeepSeekProvider } from './providers/deepseek.provider';
import { MockAiProvider } from './providers/mock.provider';
import { SettingsService } from '../settings/settings.service';
import { runtime } from '../settings/runtime-config';
import { ProviderConfigService } from './provider-config.service';

export interface AiProviderOverrides {
  /** 指定供应商（不传则用当前生效的 AI_PROVIDER） */
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface AiTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

const DEFAULT_MODEL = 'deepseek-flash';

/**
 * Builds the AI client from the runtime configuration (database first, then .env) and caches it
 * until the settings revision changes, so switching provider or key takes effect without a restart.
 */
@Injectable()
export class AiProviderFactory {
  private readonly logger = new Logger(AiProviderFactory.name);
  private cached: { revision: number; signature: string; provider: AiProvider } | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly providerConfigs: ProviderConfigService,
  ) {}

  async get(): Promise<AiProvider> {
    const signature = await this.signature();
    if (this.cached && this.cached.revision === this.settings.revision && this.cached.signature === signature) {
      return this.cached.provider;
    }
    const provider = await this.build();
    this.cached = { revision: this.settings.revision, signature, provider };
    this.logger.log(`AI 提供方已就绪：${provider.name}（模型 ${provider.model}）`);
    return provider;
  }

  /** Builds a throwaway provider for the「测试连接」button, using unsaved form values when given. */
  async create(overrides: AiProviderOverrides = {}): Promise<AiProvider> {
    return this.build(overrides);
  }

  async test(overrides: AiProviderOverrides = {}): Promise<AiTestResult> {
    const startedAt = Date.now();
    let provider: AiProvider | null = null;
    try {
      provider = await this.build(overrides);
      const completion = await provider.complete({
        task: 'generate',
        system: '你是连接测试助手，只回复两个字。',
        user: '请回复：连接正常',
        /**
         * 推理模型（deepseek-flash）会先思考再回答，512 太小：实测光思考就 870 字，
         * 于是"连接测试"永远报失败，让人误以为 Key 不对。这里给足预算。
         */
        maxTokens: Math.max(runtime().ai.maxTokens, 1024),
        temperature: 0,
      });
      return {
        ok: true,
        provider: provider.name,
        model: completion.model,
        latencyMs: Date.now() - startedAt,
        reply: completion.text.slice(0, 80),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      /**
       * 输出被截断只说明"答得太长"，不能说明凭据有问题：
       * 能拿到模型响应就意味着鉴权与网络都通了，测试结果要如实区分。
       */
      if (/max_tokens 截断|只返回了思考过程/.test(message)) {
        return {
          ok: true,
          provider: provider?.name ?? (await this.settings.get('AI_PROVIDER')) ?? 'unknown',
          model: provider?.model ?? overrides.model ?? (await this.settings.get('AI_MODEL')) ?? DEFAULT_MODEL,
          latencyMs: Date.now() - startedAt,
          reply: '（模型只返回了思考过程，连接与鉴权正常）',
        };
      }
      return {
        ok: false,
        provider: provider?.name ?? (await this.settings.get('AI_PROVIDER')) ?? 'unknown',
        model: provider?.model ?? overrides.model ?? (await this.settings.get('AI_MODEL')) ?? DEFAULT_MODEL,
        latencyMs: Date.now() - startedAt,
        error: message,
      };
    }
  }

  /**
   * 用给定（或已保存）的凭据去供应商拉取可用模型列表。
   *
   * 「AI 配置」模块的流程是：填 Key → 测试连接 → 获取模型 → 从列表里选默认模型。
   * 这里复用 create()，保证拉模型用的就是刚才测试通过的那套凭据。
   */
  async fetchModels(overrides: AiProviderOverrides = {}): Promise<{ ok: boolean; models: string[]; error?: string }> {
    try {
      const provider = await this.build(overrides);
      if (!provider.listModels) {
        return { ok: false, models: [], error: `${provider.name} 不支持自动获取模型列表（该协议没有 /models 接口），请手动填写模型标识` };
      }
      const models = await provider.listModels();
      if (models.length === 0) return { ok: false, models: [], error: '供应商返回了空的模型列表' };
      return { ok: true, models };
    } catch (error) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async describe(): Promise<{ provider: string; model: string }> {
    const provider = await this.get();
    return { provider: provider.name, model: provider.model };
  }

  private async signature(): Promise<string> {
    return [
      await this.settings.get('AI_PROVIDER'),
      await this.settings.get('AI_MODEL'),
      await this.settings.get('AI_API_BASE'),
      (await this.settings.get('AI_API_KEY')) ? 'key-set' : 'no-key',
    ].join('|');
  }

  private async build(overrides: AiProviderOverrides = {}): Promise<AiProvider> {
    const name = overrides.provider?.trim().toLowerCase() || ((await this.settings.get('AI_PROVIDER')) ?? 'deepseek').trim().toLowerCase();

    /**
     * 离线模式必须在最前面判断：一旦配了真实供应商凭据，后面的"多供应商配置"分支会用它去发起真实请求，
     * 于是把 AI_PROVIDER 设成 mock 反而会花钱（曾经真的用 mock-model 去调 DeepSeek 并报 400）。
     */
    if (name === 'mock') return new MockAiProvider('mock-model（离线占位，未配置真实 Key）');

    // 多供应商配置优先：同一实例里可以存多套凭据，按 provider 取对应的密钥/地址/模型
    const config = await this.providerConfigs.find(name);
    if (config && (config.apiKey || overrides.apiKey)) {
      const configuredModel = overrides.model?.trim() || (await this.settings.get('AI_MODEL'))?.trim() || config.models[0] || DEFAULT_MODEL;
      // 仅当"当前使用的供应商"就是它时，才用它的默认模型；否则用配置里的第一个模型
      const model = config.models.includes(configuredModel) ? configuredModel : (config.models[0] ?? configuredModel);
      return this.buildClient({
        providerId: name,
        model,
        apiKey: overrides.apiKey?.trim() || config.apiKey,
        baseUrl: overrides.baseUrl?.trim() || config.baseUrl || undefined,
      });
    }

    const model = overrides.model?.trim() || (await this.settings.get('AI_MODEL'))?.trim() || DEFAULT_MODEL;

    // Offline placeholder: keep the model name honest so nobody mistakes it for a real model run.
    if (name === 'mock') return new MockAiProvider('mock-model（离线占位，未配置真实 Key）');

    const apiKey = overrides.apiKey?.trim() || (await this.settings.get('AI_API_KEY'))?.trim() || '';
    const baseUrl = overrides.baseUrl?.trim() || (await this.settings.get('AI_API_BASE'))?.trim() || undefined;
    return this.buildClient({ providerId: name, model, apiKey, baseUrl });
  }

  /** 统一的 OpenAI 兼容客户端（多数供应商都提供兼容接口）。 */
  private buildClient(input: { providerId: string; model: string; apiKey: string; baseUrl?: string }): AiProvider {
    return new DeepSeekProvider({ apiKey: input.apiKey, model: input.model, baseUrl: input.baseUrl, providerId: input.providerId });
  }
}
