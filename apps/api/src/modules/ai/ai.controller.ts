import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { Capability } from '../auth/capabilities';
import { Roles } from '../auth/roles.decorator';
import { AiGeneration } from './entities/ai-generation.entity';
import { AiService } from './ai.service';
import { ComplianceReport } from './ai.types';
import { ComplianceCheckDto, GenerateTextDto, OptimizeTitleDto, QueryAiGenerationDto } from './dto/ai.dto';
import { ModelPricingService } from './model-pricing.service';
import { ProviderConfigService } from './provider-config.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly pricingService: ModelPricingService,
    private readonly providerConfigService: ProviderConfigService,
  ) {}

  @Public()
  @Get('status')
  status(): Promise<{ provider: string; model: string }> {
    return this.aiService.describe();
  }

  /**
   * AI 用量与花费：可按供应商 + 模型筛选；读操作所有登录角色可见。
   * 返回供应商/模型价目、四段计费明细、按天/按任务/按模型统计。
   */
  @Get('usage')
  usage(@Query('days') days?: string, @Query('provider') provider?: string, @Query('model') model?: string) {
    return this.aiService.usage(days ? Number(days) : 14, { provider: provider || undefined, model: model || undefined });
  }

  /** 供应商与模型价目（供应商标签 + 每个模型的实付价/官方价） */
  @Get('providers')
  providers(@Query('onlyConfigured') onlyConfigured?: string) {
    return this.pricingService.list({ onlyConfigured: onlyConfigured !== 'false' });
  }

  /** 已配置的供应商（密钥打码） */
  @Get('provider-configs')
  providerConfigs() {
    return this.providerConfigService.listMasked();
  }

  /** 新增/更新供应商配置（密钥留空表示不修改） */
  @Capability('settings.write')
  @Put('provider-configs')
  upsertProvider(@Body() body: Record<string, unknown>) {
    return this.providerConfigService.upsert({
      provider: String(body.provider ?? ''),
      label: body.label === undefined ? undefined : String(body.label),
      baseUrl: body.baseUrl === undefined ? undefined : String(body.baseUrl),
      apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
      models: Array.isArray(body.models) ? body.models.map((item) => String(item)) : undefined,
      protocol: body.protocol as never,
      // 接入方式必须透传：从「AI 用量」页编辑供应商时若丢掉它，
      // 已配置的中转渠道会被悄悄当成官方直连，计费又回到按官方价算。
      kind: body.kind as never,
    });
  }

  /** 删除供应商配置（用量历史保留） */
  @Capability('settings.write')
  @Delete('provider-configs/:provider')
  removeProvider(@Param('provider') provider: string) {
    return this.providerConfigService.remove(provider);
  }

  /** 预置供应商与模型目录（"添加供应商"下拉用） */
  @Get('catalog')
  catalog() {
    return { providers: ProviderConfigService.catalogOptions(), models: this.pricingService.catalog() };
  }

  /** 覆盖单个模型的实付价（元/百万 token，四段） */
  @Capability('settings.write')
  @Put('model-price')
  async setModelPrice(@Body() body: { provider?: string; model?: string; price?: Record<string, number> }): Promise<{ ok: true }> {
    const provider = String(body.provider ?? '');
    const model = String(body.model ?? '');
    if (!provider || !model) throw new BadRequestException('缺少 provider 或 model');
    const price = body.price;
    /**
     * 以前这里对缺字段是"补齐为 0"，结果一次手滑的请求就把某个模型全部价格写成 0，
     * 计费会静默少算。现在缺价格或全 0 一律拒绝。
     */
    if (!price || typeof price !== 'object') throw new BadRequestException('缺少 price（输入/输出等单价，元/百万 token）');
    const values = [price.input, price.output, price.cacheWrite, price.cacheRead]
      .map((value) => Number(value ?? 0))
      .map((value) => (Number.isFinite(value) && value >= 0 ? value : NaN));
    if (values.some((value) => Number.isNaN(value))) throw new BadRequestException('价格必须是 ≥ 0 的数字');
    if (values.every((value) => value === 0)) throw new BadRequestException('价格不能全为 0；如需恢复官方价请用「恢复官方价」');
    await this.pricingService.setOverride(`${provider}/${model}`, {
      input: values[0],
      output: values[1],
      cacheWrite: values[2],
      cacheRead: values[3],
    });
    return { ok: true };
  }

  /** 删除覆盖价，恢复官方美元价 × 汇率。 */
  @Capability('settings.write')
  @Delete('model-price')
  async clearModelPrice(@Query('provider') provider = '', @Query('model') model = ''): Promise<{ ok: true }> {
    if (!provider || !model) throw new BadRequestException('缺少 provider 或 model');
    await this.pricingService.clearOverride(`${provider}/${model}`);
    return { ok: true };
  }

  /** 当前计费规则（汇率、峰谷时段、公式说明） */
  @Get('pricing-rules')
  pricingRules() {
    return this.pricingService.rules();
  }

  /** 官网价格快照（最近一次抓取时间、来源、各模型峰谷价） */
  @Get('official-prices')
  officialPrices() {
    return this.pricingService.officialSnapshot();
  }

  /** 立即抓取官网价格（不传 provider 则抓取全部支持的供应商） */
  @Capability('settings.write')
  @Post('official-prices/refresh')
  async refreshOfficialPrices(@Body() body: { provider?: string }) {
    const provider = body?.provider ? String(body.provider) : undefined;
    const { results, failures, domestic, domesticError, aggregate, aggregateError } =
      await this.pricingService.refreshOfficialPrices(provider);
    return {
      fetchedAt: new Date().toISOString(),
      providers: results.map((result) => ({
        provider: result.provider,
        sourceUrl: result.sourceUrl,
        fetchedAt: result.fetchedAt,
        count: result.prices.length,
        models: result.prices,
        warning: result.warning ?? null,
      })),
      // 失败清单必须回传：否则被反爬拦住的供应商在界面上等于不存在。
      failures: failures.map((failure) => ({
        provider: failure.provider,
        message: failure.message,
      })),
      // 国内权威参考价（国家超算互联网）：官网抓不到时的首选兜底（人民币）
      domestic,
      domesticError,
      // 聚合价目表（models.dev）：官网抓不到的供应商靠它兜底
      aggregate,
      aggregateError,
      warning: results.length ? null : '未抓取到任何价格',
    };
  }

  @Capability('content.write')
  @Post('generate')
  generate(
    @Body() dto: GenerateTextDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ text: string; generationId: string }> {
    return this.aiService.generate(dto.prompt, dto.tone, {
      inputRefs: { title: dto.title ?? null },
      requestedBy: toActor(user).id ?? null,
    });
  }

  @Capability('content.write')
  @Post('optimize-title')
  optimizeTitle(
    @Body() dto: OptimizeTitleDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ titles: string[]; generationId: string }> {
    return this.aiService.optimizeTitle(dto.title, dto.platform, dto.keywords, { requestedBy: toActor(user).id ?? null });
  }

  @Capability('content.write')
  @Post('compliance-check')
  complianceCheck(
    @Body() dto: ComplianceCheckDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<ComplianceReport> {
    return this.aiService.complianceCheck({ text: dto.text, platform: dto.platform, useAiReview: dto.useAiReview }, {
      requestedBy: toActor(user).id ?? null,
    });
  }

  @Roles('owner', 'admin', 'editor', 'reviewer', 'viewer')
  @Get('generations')
  generations(@Query() query: QueryAiGenerationDto): Promise<{
    items: AiGeneration[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    return this.aiService.listGenerations(query);
  }
}
