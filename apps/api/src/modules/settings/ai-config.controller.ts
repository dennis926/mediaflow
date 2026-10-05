import { BadRequestException, Body, Controller, Get, Post, Put } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Capability } from '../auth/capabilities';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { ProviderConfigService } from '../ai/provider-config.service';
import { DEFAULT_MODEL_CATALOG, findCatalogProvider } from '../ai/model-catalog';
import { SettingsService } from './settings.service';

export interface AiConnectionView {
  /** 当前生效的配置（数据库优先，其次 .env） */
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  /** 当前使用的是离线占位还是真实供应商 */
  offline: boolean;
  /** 预置供应商目录，界面上的"选择供应商"下拉用 */
  catalog: Array<{ provider: string; label: string; defaultBaseUrl: string; models: string[]; protocol: string }>;
}

interface TestInput {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * 「AI 配置」独立模块。
 *
 * 用户要求：AI 配置要单独一个模块，包括①测试连接是否成功 ②成功后获取模型 ③可以选择默认使用的模型。
 * 三步是一个闭环：填凭据 → 测通 → 拉模型 → 选默认 → 保存。任何一步失败都要能看懂原因，
 * 所以每个接口都返回 ok + error 而不是抛 500。
 */
@Controller('ai-config')
export class AiConfigController {
  constructor(
    private readonly settings: SettingsService,
    private readonly providers: AiProviderFactory,
    private readonly providerConfigs: ProviderConfigService,
  ) {}

  /** 当前 AI 配置概览（密钥打码）。 */
  @Capability('settings.write')
  @Get()
  async view(): Promise<AiConnectionView> {
    const provider = ((await this.settings.get('AI_PROVIDER')) ?? 'deepseek').trim();
    const model = ((await this.settings.get('AI_MODEL')) ?? '').trim();
    const apiKey = ((await this.settings.get('AI_API_KEY')) ?? '').trim();
    const baseUrl = ((await this.settings.get('AI_API_BASE')) ?? '').trim() || (findCatalogProvider(provider)?.defaultBaseUrl ?? '');

    const saved = await this.providerConfigs.listMasked();
    const savedForProvider = saved.find((item) => item.provider === provider);

    return {
      provider,
      model,
      baseUrl,
      apiKeyMasked: savedForProvider?.apiKeyMasked || (apiKey ? `${apiKey.slice(0, 6)}***${apiKey.slice(-4)}` : ''),
      hasApiKey: Boolean(savedForProvider?.hasApiKey || apiKey),
      offline: provider === 'mock' || (!apiKey && !savedForProvider?.hasApiKey),
      catalog: DEFAULT_MODEL_CATALOG.map((item) => ({
        provider: item.provider,
        label: item.label,
        defaultBaseUrl: item.defaultBaseUrl,
        models: item.models.map((entry) => entry.model),
        protocol: item.protocol,
      })),
    };
  }

  /** 第一步：测试连接。表单里填了值就用表单值，没填就用已保存的。 */
  @Capability('settings.write')
  @Post('test')
  async test(@Body() body: TestInput) {
    const overrides = await this.resolveOverrides(body);
    const result = await this.providers.test(overrides);
    return result;
  }

  /** 第二步：获取模型列表（用同一套凭据）。 */
  @Capability('settings.write')
  @Post('models')
  async models(@Body() body: TestInput) {
    const overrides = await this.resolveOverrides(body);
    return this.providers.fetchModels(overrides);
  }

  /**
   * 第三步：保存并设为默认。
   *
   * 一次性写入四件事，避免用户分多次保存出现"Key 换了但模型还是旧的"这种中间态：
   *   ① 供应商配置（多套凭据表） ② 当前生效供应商 ③ 默认模型 ④ 接口地址
   */
  @Capability('settings.write')
  @Put('default')
  async saveDefault(
    @Body() body: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; models?: string[] },
    @CurrentUser() user?: AuthUser,
  ) {
    const provider = String(body?.provider ?? '').trim();
    const model = String(body?.model ?? '').trim();
    if (!provider) throw new BadRequestException('缺少 provider');
    if (!model) throw new BadRequestException('请选择默认使用的模型');

    const apiKey = body?.apiKey?.trim();
    const baseUrl = body?.baseUrl?.trim();
    const catalog = findCatalogProvider(provider);
    const models = Array.isArray(body?.models) && body.models.length > 0
      ? body.models.map((item) => String(item).trim()).filter(Boolean)
      : [model];

    // 多供应商凭据表：把这次测试通过的凭据存下来，方便以后一键切换
    if (apiKey && !apiKey.includes('***')) {
      await this.providerConfigs.upsert({
        provider,
        label: catalog?.label ?? provider,
        baseUrl: baseUrl || catalog?.defaultBaseUrl || '',
        apiKey,
        models: [...new Set([model, ...models])],
        protocol: catalog?.protocol ?? 'openai-compatible',
      });
    }

    await this.settings.updateMany(
      [
        { key: 'AI_PROVIDER', value: provider },
        { key: 'AI_MODEL', value: model },
        { key: 'AI_API_BASE', value: baseUrl ?? '' },
        // 密钥只在填了新值时才覆盖（打码值会被 SettingsService 忽略）
        ...(apiKey && !apiKey.includes('***') ? [{ key: 'AI_API_KEY', value: apiKey }] : []),
      ],
      toActor(user),
    );

    return this.view();
  }

  /** 切换成离线占位（不消耗任何额度），用于本地演示或排查。 */
  @Capability('settings.write')
  @Put('offline')
  async offline(@CurrentUser() user?: AuthUser) {
    await this.settings.updateMany([{ key: 'AI_PROVIDER', value: 'mock' }], toActor(user));
    return this.view();
  }

  /**
   * 表单值优先，缺的项回退到已保存的配置。
   * 这样"只改模型不重填 Key"和"只换 Key 不改模型"两种操作都能测通。
   */
  private async resolveOverrides(body: TestInput) {
    const provider = body?.provider?.trim() || ((await this.settings.get('AI_PROVIDER')) ?? 'deepseek');
    const savedKey = (await this.settings.get('AI_API_KEY')) ?? '';
    const savedBase = (await this.settings.get('AI_API_BASE')) ?? '';
    const savedModel = (await this.settings.get('AI_MODEL')) ?? '';
    const config = await this.providerConfigs.find(provider);

    const typedKey = body?.apiKey?.trim();
    const apiKey = typedKey && !typedKey.includes('***') ? typedKey : config?.apiKey || savedKey || undefined;

    return {
      provider,
      apiKey,
      model: body?.model?.trim() || savedModel || config?.models[0] || undefined,
      baseUrl: body?.baseUrl?.trim() || config?.baseUrl || savedBase || undefined,
    };
  }
}
