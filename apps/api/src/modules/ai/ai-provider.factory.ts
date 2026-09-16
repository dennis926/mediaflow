import { Injectable, Logger } from '@nestjs/common';
import { AiProvider } from './ai.types';
import { DeepSeekProvider } from './providers/deepseek.provider';
import { MockAiProvider } from './providers/mock.provider';
import { SettingsService } from '../settings/settings.service';

export interface AiProviderOverrides {
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

const DEFAULT_MODEL = 'deepseek-v4-flash-0731';

/**
 * Builds the AI client from the runtime configuration (database first, then .env) and caches it
 * until the settings revision changes, so switching provider or key takes effect without a restart.
 */
@Injectable()
export class AiProviderFactory {
  private readonly logger = new Logger(AiProviderFactory.name);
  private cached: { revision: number; signature: string; provider: AiProvider } | null = null;

  constructor(private readonly settings: SettingsService) {}

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
        maxTokens: 16,
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
    const name = ((await this.settings.get('AI_PROVIDER')) ?? 'deepseek').trim().toLowerCase();
    const model = overrides.model?.trim() || (await this.settings.get('AI_MODEL'))?.trim() || DEFAULT_MODEL;

    if (name === 'mock') return new MockAiProvider(model);

    const apiKey = overrides.apiKey?.trim() || (await this.settings.get('AI_API_KEY'))?.trim() || '';
    const baseUrl = overrides.baseUrl?.trim() || (await this.settings.get('AI_API_BASE'))?.trim() || undefined;
    return new DeepSeekProvider({ apiKey, model, baseUrl });
  }
}
