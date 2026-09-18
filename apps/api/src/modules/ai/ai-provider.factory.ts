import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from './ai.types';
import { DeepSeekProvider } from './providers/deepseek.provider';
import { MockAiProvider } from './providers/mock.provider';
import { SettingsService } from '../settings/settings.service';
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
    try {
      const provider = await this.build(overrides);
      const completion = await provider.complete({
        task: 'generate',
        system: '你是连接测试助手，只回复两个字。',
        user: '请回复：连接正常',
        // Reasoning models need headroom for the thinking pass before the answer.
        maxTokens: 512,
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
      return {
        ok: false,
        provider: (await this.settings.get('AI_PROVIDER')) ?? 'unknown',
        model: overrides.model ?? (await this.settings.get('AI_MODEL')) ?? DEFAULT_MODEL,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
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
