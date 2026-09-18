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
      multiplier: body.multiplier === undefined ? undefined : Number(body.multiplier),
      protocol: body.protocol as never,
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
    const price = body.price ?? {};
    await this.pricingService.setOverride(`${provider}/${model}`, {
      input: Number(price.input ?? 0),
      output: Number(price.output ?? 0),
      cacheWrite: Number(price.cacheWrite ?? 0),
      cacheRead: Number(price.cacheRead ?? 0),
    });
    return { ok: true };
  }

  /** 当前计费规则（汇率与公式说明） */
  @Get('pricing-rules')
  pricingRules() {
    return this.pricingService.rules();
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
