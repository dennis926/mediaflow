import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_MODEL_CATALOG, findCatalogProvider } from './model-catalog';

export const PROVIDER_CONFIGS_KEY = 'AI_PROVIDER_CONFIGS';

export interface ProviderConfig {
  /** 供应商标识，与价目表 catalog 的 provider 对齐（deepseek / openai / anthropic / ...） */
  provider: string;
  label: string;
  /** OpenAI 兼容地址或 Anthropic 原生地址 */
  baseUrl: string;
  /** 密钥（只在服务端保存，接口返回时打码） */
  apiKey: string;
  /** 该供应商下要用的模型列表（界面上的模型标签） */
  models: string[];
  protocol: 'openai-compatible' | 'anthropic';
}

export interface ProviderConfigView extends Omit<ProviderConfig, 'apiKey'> {
  /** 打码后的密钥，例如 sk-abc***1234 */
  apiKeyMasked: string;
  hasApiKey: boolean;
  modelCount: number;
}

/**
 * 多供应商配置。
 *
 * 之前只能配一套（AI_PROVIDER / AI_API_KEY），而用户实际会在 DeepSeek、GPT、Claude、GLM 之间切换。
 * 这里把"多套凭据 + 各自模型"存成一份加密配置（AI_PROVIDER_CONFIGS），
 * 与旧的单套配置并存：旧配置作为"当前使用的供应商"，多套配置用于价目展示与逐模型用量归属。
 */
@Injectable()
export class ProviderConfigService {
  private readonly logger = new Logger(ProviderConfigService.name);

  constructor(private readonly settings: SettingsService) {}

  /** 全部供应商配置（含密钥，仅服务端内部使用）。 */
  async list(): Promise<ProviderConfig[]> {
    const raw = await this.settings.get(PROVIDER_CONFIGS_KEY);
    const fromSettings = this.parse(raw);

    // 兼容旧配置：只有 AI_API_KEY 时，把它视为一个已配置的供应商
    const activeProvider = (await this.settings.get('AI_PROVIDER')) ?? '';
    const legacyKey = (await this.settings.get('AI_API_KEY')) ?? '';
    if (legacyKey && activeProvider && !fromSettings.some((item) => item.provider === activeProvider)) {
      const activeModel = (await this.settings.get('AI_MODEL')) ?? '';
      const catalog = findCatalogProvider(activeProvider);
      fromSettings.unshift({
        provider: activeProvider,
        label: catalog?.label ?? activeProvider,
        baseUrl: (await this.settings.get('AI_API_BASE')) ?? catalog?.defaultBaseUrl ?? '',
        apiKey: legacyKey,
        models: activeModel ? [activeModel] : (catalog?.models.map((model) => model.model) ?? []),
        protocol: 'openai-compatible',
      });
    }
    return fromSettings;
  }

  /** 打码后的配置（接口返回给前端）。 */
  async listMasked(): Promise<ProviderConfigView[]> {
    const configs = await this.list();
    return configs.map((config) => ({
      provider: config.provider,
      label: config.label,
      baseUrl: config.baseUrl,
      models: config.models,
      protocol: config.protocol,
      apiKeyMasked: ProviderConfigService.mask(config.apiKey),
      hasApiKey: Boolean(config.apiKey),
      modelCount: config.models.length,
    }));
  }

  /** 新增或更新一个供应商配置；apiKey 传空或打码值时保留原密钥。 */
  async upsert(input: Partial<ProviderConfig> & { provider: string }): Promise<ProviderConfigView[]> {
    const configs = await this.list();
    const index = configs.findIndex((item) => item.provider === input.provider);
    const existing = index >= 0 ? configs[index] : undefined;
    const catalog = findCatalogProvider(input.provider);

    const apiKey = input.apiKey && !input.apiKey.includes('***') ? input.apiKey : (existing?.apiKey ?? '');
    const models = (input.models ?? existing?.models ?? catalog?.models.map((model) => model.model) ?? []).filter(Boolean);
    if (models.length === 0) throw new BadRequestException('至少填写一个模型标识');

    const next: ProviderConfig = {
      provider: input.provider,
      label: input.label?.trim() || existing?.label || catalog?.label || input.provider,
      baseUrl: input.baseUrl?.trim() || existing?.baseUrl || catalog?.defaultBaseUrl || '',
      apiKey,
      models: [...new Set(models)],
      protocol: input.protocol ?? existing?.protocol ?? catalog?.protocol ?? 'openai-compatible',
    };

    if (index >= 0) configs[index] = next;
    else configs.push(next);

    await this.settings.updateMany(
      [{ key: PROVIDER_CONFIGS_KEY, value: JSON.stringify(configs) }],
      { id: null, name: '系统' },
    );
    this.logger.log(`AI 供应商配置已更新：${next.provider}（${next.models.length} 个模型）`);
    return this.listMasked();
  }

  async remove(provider: string): Promise<ProviderConfigView[]> {
    const configs = (await this.list()).filter((item) => item.provider !== provider);
    await this.settings.updateMany(
      [{ key: PROVIDER_CONFIGS_KEY, value: configs.length > 0 ? JSON.stringify(configs) : '' }],
      { id: null, name: '系统' },
    );
    return this.listMasked();
  }

  /** 某个供应商的配置（构建客户端时用）。 */
  async find(provider: string): Promise<ProviderConfig | undefined> {
    return (await this.list()).find((item) => item.provider === provider);
  }

  /** 当前生效的供应商（旧设置里的 AI_PROVIDER）。 */
  async activeProvider(): Promise<string> {
    return (await this.settings.get('AI_PROVIDER')) ?? 'deepseek';
  }

  private parse(raw: string | null): ProviderConfig[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as ProviderConfig[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => item && typeof item.provider === 'string' && item.provider.length > 0)
        .map((item) => ({
          provider: item.provider,
          label: item.label ?? item.provider,
          baseUrl: item.baseUrl ?? '',
          apiKey: item.apiKey ?? '',
          models: Array.isArray(item.models) ? item.models : [],
          protocol: item.protocol ?? 'openai-compatible',
        }));
    } catch {
      this.logger.warn('AI_PROVIDER_CONFIGS 不是合法 JSON，已忽略');
      return [];
    }
  }

  private static mask(apiKey: string): string {
    if (!apiKey) return '';
    if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}***`;
    return `${apiKey.slice(0, 6)}***${apiKey.slice(-4)}`;
  }

  /** 预置供应商清单（界面"添加供应商"下拉用）。 */
  static catalogOptions(): Array<{ provider: string; label: string; defaultBaseUrl: string }> {
    return DEFAULT_MODEL_CATALOG.map((item) => ({
      provider: item.provider,
      label: item.label,
      defaultBaseUrl: item.defaultBaseUrl,
    }));
  }
}
