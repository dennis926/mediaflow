import { BadGatewayException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AiFlagType, PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { FindOptionsWhere, MoreThan, Repository } from 'typeorm';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { AiGeneration } from './entities/ai-generation.entity';
import {
  AdaptedVariantPayload,
  AiCompletionResult,
  AiTaskType,
  ComplianceReport,
  KnowledgeDraft,
  KnowledgeDraftInput,
  KnowledgePolishInput,
} from './ai.types';
import { checkCompliance, scoreViolations } from './compliance.rules';
import { AiProviderFactory } from './ai-provider.factory';
import { estimateCost as estimateLegacyCost, runtime } from '../settings/runtime-config';
import { ModelPricingService } from './model-pricing.service';

export interface AiInvocationMeta {
  contentId?: string | null;
  contentVariantId?: string | null;
  requestedBy?: string | null;
  inputRefs?: Record<string, unknown>;
}

export interface AdaptInput {
  title: string;
  body: string;
  tags: string[];
  platforms: PlatformCode[];
  tone?: string;
  keywords?: string[];
  aiFlagType: AiFlagType;
  /** 品牌知识库检索结果：会拼进 prompt，并把 id 记入 ai_generations.inputRefs 以便追溯。 */
  knowledge?: { ids: string[]; section: string };
}

export interface ComplianceInput {
  text: string;
  platform?: PlatformCode;
  useAiReview?: boolean;
}

/**
 * 写作规范与平台指引都是可配置项（设置 → AI 服务 → 写作规范 / 平台风格指引），
 * 换行业时改配置即可，不用改代码。取值见 runtime-config.ts。
 */
const platformGuidance = (platform: PlatformCode): string =>
  runtime().ai.platformGuidance[platform] ?? '常规风格';
const systemEditor = (): string => runtime().ai.systemPrompt;
const SYSTEM_JSON = '只输出 JSON，不要输出任何解释文字或 Markdown 代码块。';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @InjectRepository(AiGeneration) private readonly generations: Repository<AiGeneration>,
    private readonly aiProviders: AiProviderFactory,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly pricing: ModelPricingService,
  ) {}

  /** Reads the effective provider from the runtime settings (database over .env). */
  async describe(): Promise<{ provider: string; model: string }> {
    return this.aiProviders.describe();
  }

  async generate(prompt: string, tone: string | undefined, meta: AiInvocationMeta): Promise<{ text: string; generationId: string }> {
    const invocation = await this.invoke({
      task: 'generate',
      system: `${systemEditor()}${tone ? ` 语气要求：${tone}。` : ''}`,
      user: prompt,
      meta,
      parse: (completion) => completion.text,
    });
    return { text: invocation.result, generationId: invocation.generationId };
  }

  async adapt(input: AdaptInput, meta: AiInvocationMeta): Promise<{ variants: AdaptedVariantPayload[]; generationId: string; model: string }> {
    const guidance = input.platforms
      .map((platform) => `- ${PLATFORM_LABELS[platform]}(${platform})：${platformGuidance(platform)}`)
      .join('\n');

    const invocation = await this.invoke({
      task: 'adapt',
      system: `${systemEditor()}${SYSTEM_JSON}`,
      json: true,
      user: [
        '请把以下内容改写为指定平台各自的版本，保留事实信息，不新增疗效描述。',
        input.knowledge?.section ? input.knowledge.section : '',
        `platforms=${input.platforms.join(',')}`,
        `title=${input.title}`,
        `body=${input.body}`,
        `tags=${input.tags.join(',')}`,
        input.tone ? `语气=${input.tone}` : '',
        input.keywords?.length ? `需要覆盖的关键词=${input.keywords.join(',')}` : '',
        '',
        '各平台要求：',
        guidance,
        '',
        '输出格式：{"variants":[{"platform":"平台代码","title":"标题","body":"正文","tags":["标签"]}]}',
      ]
        .filter(Boolean)
        .join('\n'),
      meta: {
        ...meta,
        inputRefs: {
          ...meta.inputRefs,
          platforms: input.platforms,
          ...(input.knowledge?.ids.length ? { knowledgeIds: input.knowledge.ids } : {}),
        },
      },
      parse: (completion) => this.parseVariants(completion.text, input.platforms),
    });

    return { variants: invocation.result, generationId: invocation.generationId, model: invocation.model };
  }

  /**
   * 知识库条目生成：运营给几个要点，AI 按分类规范扩写成一条可直接使用的品牌资料。
   * 只返回草案，由人工确认后再入库（AI 生成内容必须经人确认，见 AGENTS.md 第 5 节）。
   */
  async generateKnowledge(
    input: KnowledgeDraftInput,
    meta: AiInvocationMeta,
  ): Promise<{ draft: KnowledgeDraft; generationId: string; model: string }> {
    const references = (input.references ?? [])
      .map((item, index) => `参考${index + 1}｜${item.title}：${item.content.slice(0, 200)}`)
      .join('\n');

    const invocation = await this.invoke({
      task: 'knowledge_generate',
      system: `${systemEditor()}${SYSTEM_JSON}`,
      json: true,
      user: [
        '请把运营给的要点扩写成一条标准品牌资料，供后续内容生成引用。',
        `brand=${input.brand}`,
        `category=${input.category}`,
        input.platform ? `适用平台=${input.platform}` : '',
        input.tone ? `语气=${input.tone}` : '',
        `points=${input.points}`,
        references ? `以下是该品牌已有资料，新条目必须与之一致，不得冲突：\n${references}` : '',
        '',
        '要求：只写可验证的事实（配方、规格、工艺、人群、用法），不写治疗功效、不做效果承诺、不使用绝对化用语。',
        'content 用简洁短句分条，控制在 400 字以内。',
        '输出格式：{"title":"不超过 30 字的标题","content":"条目正文","tags":["标签"],"keywords":["关键词"]}',
      ]
        .filter(Boolean)
        .join('\n'),
      meta,
      parse: (completion) => this.parseKnowledgeDraft(completion.text),
    });

    return { draft: invocation.result, generationId: invocation.generationId, model: invocation.model };
  }

  /** 润色/规范化一条已有资料：只改表达，不动事实。 */
  async polishKnowledge(input: KnowledgePolishInput, meta: AiInvocationMeta): Promise<{ content: string; generationId: string }> {
    const invocation = await this.invoke({
      task: 'knowledge_polish',
      system: `${systemEditor()}${SYSTEM_JSON}`,
      json: true,
      user: [
        '请润色下面这条品牌资料：保持全部事实、数字、规格不变，只让表达更清晰、更适合被内容生成引用。',
        `brand=${input.brand}`,
        `category=${input.category}`,
        input.instruction ? `额外要求=${input.instruction}` : '',
        '同时检查是否有违反广告法的表述，若有请改为合规说法。',
        `content=${input.content}`,
        '输出格式：{"content":"润色后的正文"}',
      ]
        .filter(Boolean)
        .join('\n'),
      meta,
      parse: (completion) => this.parsePolished(completion.text),
    });
    return { content: invocation.result, generationId: invocation.generationId };
  }

  async optimizeTitle(
    title: string,
    platform: PlatformCode | undefined,
    keywords: string[] | undefined,
    meta: AiInvocationMeta,
  ): Promise<{ titles: string[]; generationId: string }> {
    const invocation = await this.invoke({
      task: 'optimize_title',
      system: `${systemEditor()}${SYSTEM_JSON}`,
      json: true,
      user: [
        `title=${title}`,
        platform ? `platform=${platform}（${PLATFORM_LABELS[platform]}）` : '',
        keywords?.length ? `关键词=${keywords.join(',')}` : '',
        '请给出 3 个不超过 20 字的标题，不使用绝对化用语。',
        '输出格式：{"titles":["标题1","标题2","标题3"]}',
      ]
        .filter(Boolean)
        .join('\n'),
      meta,
      parse: (completion) => this.parseTitles(completion.text),
    });
    return { titles: invocation.result, generationId: invocation.generationId };
  }

  /** Rules always run locally; the model adds an explanatory review when it is reachable. */
  async complianceCheck(input: ComplianceInput, meta: AiInvocationMeta): Promise<ComplianceReport> {
    const violations = checkCompliance(input.text);
    const report: ComplianceReport = {
      passed: violations.length === 0,
      score: scoreViolations(violations),
      violations,
    };

    if (input.useAiReview === false) return report;

    try {
      const invocation = await this.invoke({
        task: 'compliance_check',
        system: `${systemEditor()}${SYSTEM_JSON}`,
        json: true,
        user: [
          input.platform ? `platform=${input.platform}` : '',
          '请复核以下文案是否存在医疗功效、绝对化、效果承诺、权威背书等违规风险，并给出修改建议。',
          `text=${input.text}`,
          '输出格式：{"review":"复核结论与修改建议"}',
        ]
          .filter(Boolean)
          .join('\n'),
        meta,
        parse: (completion) => this.parseReview(completion.text),
      });
      report.aiReview = invocation.result;
    } catch (error) {
      // 额度/限流属于"必须让用户看到"的错误，不能退化成静默的规则结果。
      if (error instanceof HttpException) throw error;
      this.logger.warn(`AI 合规复核不可用，已返回规则结果：${error instanceof Error ? error.message : String(error)}`);
    }
    return report;
  }

  /**
   * AI 用量与花费。
   *
   * 与中转站价目表口径一致：
   * - 按**供应商 + 模型**分组（可只统计选中的供应商/模型）；
   * - 四段计费：输入 / 输出 / 缓存写入 / 缓存读取；
   * - 每行都按"该模型的单价 × 该行实际 token"重新计算，保证卡片、明细、分组三处数字一致；
   * - 同时返回调用当时记录的金额（costRecorded），单价调整后可对比差异。
   */
  async usage(days = 14, filter: { provider?: string; model?: string } = {}): Promise<{
    range: { days: number; from: string };
    filter: { provider: string | null; model: string | null };
    summary: {
      calls: number;
      failed: number;
      tokensInput: number;
      tokensOutput: number;
      tokensCached: number;
      tokensCacheWrite: number;
      tokensReasoning: number;
      cacheHitRate: number;
      cost: string;
      costRecorded: string;
      avgLatencyMs: number;
      avgCostPerCall: string;
      priceConfigured: boolean;
    };
    costBreakdown: { input: string; output: string; cacheWrite: string; cacheRead: string; total: string };
    pricing: {
      provider: string;
      model: string;
      label: string;
      price: { input: number; output: number; cacheWrite: number; cacheRead: number };
      officialUsd: { input: number; output: number; cacheWrite: number; cacheRead: number };
      source: string;
    } | null;
    byDay: Array<{ date: string; calls: number; tokens: number; cached: number; cost: string }>;
    byTask: Array<{ taskType: string; calls: number; tokens: number; cached: number; cost: string }>;
    byModel: Array<{ provider: string; model: string; calls: number; tokens: number; cost: string }>;
    models: Array<{
      provider: string;
      providerLabel: string;
      model: string;
      label: string;
      price: { input: number; output: number; cacheWrite: number; cacheRead: number };
      officialUsd: { input: number; output: number; cacheWrite: number; cacheRead: number };
      source: string;
      configured: boolean;
      reference: boolean;
      calls: number;
      tokens: number;
      cost: string;
    }>;
    providers: Array<{
      provider: string;
      label: string;
      configured: boolean;
      baseUrl: string;
      models: Array<Record<string, unknown>>;
    }>;
    rules: { usdToCny: number; description: string };
    note: string | null;
  }> {
    const scope = await this.workspaceContext.current();
    const boundedDays = Math.min(Math.max(days, 1), 180);
    const since = new Date(Date.now() - boundedDays * 86_400_000);

    const where: FindOptionsWhere<AiGeneration> = { workspaceId: scope.workspaceId, createdAt: MoreThan(since) };
    if (filter.provider) where.provider = filter.provider;
    if (filter.model) where.model = filter.model;

    const rows = await this.generations.find({ where, order: { createdAt: 'DESC' }, take: 20_000 });

    // 价格缓存：同一 (provider, model) 只解析一次
    const priceCache = new Map<string, { price: { input: number; output: number; cacheWrite: number; cacheRead: number }; source: string }>();
    const priceFor = async (provider: string, model: string): Promise<{ price: { input: number; output: number; cacheWrite: number; cacheRead: number }; source: string }> => {
      const key = `${provider}/${model}`;
      const cached = priceCache.get(key);
      if (cached) return cached;
      const resolved = await this.pricing.priceFor(provider, model).catch(() => null);
      const value = resolved
        ? { price: resolved.price, source: resolved.source }
        : { price: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, source: 'unset' };
      priceCache.set(key, value);
      return value;
    };

    const dayMap = new Map<string, { calls: number; tokens: number; cached: number; cost: number }>();
    const taskMap = new Map<string, { calls: number; tokens: number; cached: number; cost: number }>();
    const modelMap = new Map<string, { provider: string; model: string; calls: number; tokens: number; cost: number }>();

    let tokensInput = 0;
    let tokensOutput = 0;
    let tokensCached = 0;
    let tokensCacheWrite = 0;
    let tokensReasoning = 0;
    let cost = 0;
    let costRecorded = 0;
    let failed = 0;
    let latencyTotal = 0;
    const breakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

    const dayKey = (date: Date): string => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

    for (const row of rows) {
      const cachedTokens = Math.max(0, row.tokensCached ?? 0);
      const cacheWriteTokens = Math.max(0, row.tokensCacheWrite ?? 0);
      const inputTokens = Math.max(0, (row.tokensInput ?? 0) - cachedTokens);
      const outputTokens = Math.max(0, row.tokensOutput ?? 0);
      const tokens = inputTokens + cachedTokens + cacheWriteTokens + outputTokens;

      const { price } = await priceFor(row.provider ?? 'unknown', row.model ?? 'unknown');
      const rowCost = this.pricing.computeCost(
        { input: inputTokens, output: outputTokens, cacheWrite: cacheWriteTokens, cacheRead: cachedTokens },
        price,
      );

      tokensInput += row.tokensInput ?? 0;
      tokensOutput += outputTokens;
      tokensCached += cachedTokens;
      tokensCacheWrite += cacheWriteTokens;
      tokensReasoning += row.tokensReasoning ?? 0;
      cost += rowCost.total;
      costRecorded += Number(row.cost ?? 0) || 0;
      latencyTotal += row.latencyMs ?? 0;
      if (row.status === 'failed') failed += 1;
      breakdown.input += rowCost.input;
      breakdown.output += rowCost.output;
      breakdown.cacheWrite += rowCost.cacheWrite;
      breakdown.cacheRead += rowCost.cacheRead;

      const groups: Array<[Map<string, { calls: number; tokens: number; cached: number; cost: number }>, string]> = [
        [dayMap, dayKey(new Date(row.createdAt))],
        [taskMap, row.taskType],
      ];
      for (const [map, key] of groups) {
        const current = map.get(key) ?? { calls: 0, tokens: 0, cached: 0, cost: 0 };
        map.set(key, { calls: current.calls + 1, tokens: current.tokens + tokens, cached: current.cached + cachedTokens, cost: current.cost + rowCost.total });
      }

      const modelKey = `${row.provider ?? 'unknown'}/${row.model ?? 'unknown'}`;
      const currentModel = modelMap.get(modelKey) ?? { provider: row.provider ?? 'unknown', model: row.model ?? 'unknown', calls: 0, tokens: 0, cost: 0 };
      modelMap.set(modelKey, { ...currentModel, calls: currentModel.calls + 1, tokens: currentModel.tokens + tokens, cost: currentModel.cost + rowCost.total });
    }

    // 供应商/模型清单：已配置的供应商 + 其模型（含未使用过的模型，便于直接切过去看价）
    const providers = await this.pricing.list({ onlyConfigured: false });
    const usageByModel = new Map(modelMap);
    const models = providers.flatMap((provider) =>
      provider.models.map((model) => {
        const used = usageByModel.get(`${provider.provider}/${model.model}`);
        return {
          provider: provider.provider,
          providerLabel: provider.label,
          model: model.model,
          label: model.label,
          price: model.price,
          officialUsd: model.officialUsd,
          source: model.source,
          configured: provider.configured,
          reference: model.reference,
          calls: used?.calls ?? 0,
          tokens: used?.tokens ?? 0,
          cost: (used?.cost ?? 0).toFixed(6),
        };
      }),
    );

    const selectedPricing =
      filter.provider && filter.model
        ? await this.pricing.priceFor(filter.provider, filter.model)
        : (providers.find((provider) => provider.configured)?.models[0] ?? providers[0]?.models[0] ?? null);

    const priceConfigured = models.some((model) => model.price.input > 0 || model.price.output > 0);
    const sortedDays = [...dayMap.entries()].sort((left, right) => right[0].localeCompare(left[0])).slice(0, boundedDays);

    return {
      range: { days: boundedDays, from: since.toISOString() },
      filter: { provider: filter.provider ?? null, model: filter.model ?? null },
      summary: {
        calls: rows.length,
        failed,
        tokensInput,
        tokensOutput,
        tokensCached,
        tokensCacheWrite,
        tokensReasoning,
        cacheHitRate: tokensInput > 0 ? Number(((tokensCached / tokensInput) * 100).toFixed(1)) : 0,
        cost: cost.toFixed(6),
        costRecorded: costRecorded.toFixed(6),
        avgLatencyMs: rows.length > 0 ? Math.round(latencyTotal / rows.length) : 0,
        avgCostPerCall: rows.length > 0 ? (cost / rows.length).toFixed(6) : '0',
        priceConfigured,
      },
      costBreakdown: {
        input: breakdown.input.toFixed(6),
        output: breakdown.output.toFixed(6),
        cacheWrite: breakdown.cacheWrite.toFixed(6),
        cacheRead: breakdown.cacheRead.toFixed(6),
        total: cost.toFixed(6),
      },
      pricing: selectedPricing
        ? {
            provider: selectedPricing.provider,
            model: selectedPricing.model,
            label: selectedPricing.label,
            price: selectedPricing.price,
            officialUsd: selectedPricing.officialUsd,
            source: selectedPricing.source,
          }
        : null,
      byDay: sortedDays.map(([date, value]) => ({ date, calls: value.calls, tokens: value.tokens, cached: value.cached, cost: value.cost.toFixed(6) })),
      byTask: [...taskMap.entries()]
        .sort((left, right) => right[1].calls - left[1].calls)
        .map(([taskType, value]) => ({ taskType, calls: value.calls, tokens: value.tokens, cached: value.cached, cost: value.cost.toFixed(6) })),
      byModel: [...modelMap.values()]
        .sort((left, right) => right.calls - left.calls)
        .map((value) => ({ provider: value.provider, model: value.model, calls: value.calls, tokens: value.tokens, cost: value.cost.toFixed(6) })),
      models,
      providers: providers.map((provider) => ({
        provider: provider.provider,
        label: provider.label,
        configured: provider.configured,
        baseUrl: provider.baseUrl,
        models: provider.models as unknown as Array<Record<string, unknown>>,
      })),
      rules: await this.pricing.rules(),
      note:
        Math.abs(cost - costRecorded) > 0.000001
          ? '金额按「当前模型单价 × 实际 token」重算；调用当时记录的金额与它不同，通常是因为之后调整过价格。'
          : null,
    };
  }

  async listGenerations(query: { taskType?: AiTaskType; page?: number; pageSize?: number }): Promise<{
    items: AiGeneration[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const scope = await this.workspaceContext.current();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: FindOptionsWhere<AiGeneration> = { workspaceId: scope.workspaceId };
    if (query.taskType) where.taskType = query.taskType;

    const [items, total] = await this.generations.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } };
  }

  private async invoke<T>(params: {
    task: AiTaskType;
    system: string;
    user: string;
    json?: boolean;
    meta: AiInvocationMeta;
    parse: (completion: AiCompletionResult) => T;
  }): Promise<{ result: T; generationId: string; model: string }> {
    const scope = await this.workspaceContext.current();
    const startedAt = Date.now();
    await this.assertWithinQuota(scope.workspaceId);

    const provider = await this.aiProviders.get();
    try {
      const completion = await provider.complete({
        task: params.task,
        system: params.system,
        user: params.user,
        json: params.json,
        temperature: runtime().ai.temperature,
        maxTokens: runtime().ai.maxTokens,
      });

      /**
       * 按"模型自己的价目"计价（供应商 × 模型），而不是全站一个价：
       * 四段计费（输入 / 输出 / 缓存写入 / 缓存读取），并记录价格快照，日后调价也能说明当时的算法。
       */
      const modelTokens = {
        input: Math.max(0, (completion.tokensInput ?? 0) - (completion.tokensCached ?? 0)),
        output: completion.tokensOutput ?? 0,
        cacheWrite: completion.tokensCacheWrite ?? 0,
        cacheRead: completion.tokensCached ?? 0,
      };
      const priced = await this.pricing
        .costOf(provider.name, completion.model ?? provider.model, modelTokens)
        .catch(() => null);
      const parsed = params.parse(completion);
      const generation = await this.generations.save(
        this.generations.create({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          provider: provider.name,
          model: completion.model,
          taskType: params.task,
          status: 'success',
          prompt: params.user,
          output: completion.text,
          inputRefs: params.meta.inputRefs ?? {},
          tokensInput: completion.tokensInput,
          tokensOutput: completion.tokensOutput,
          tokensCached: completion.tokensCached ?? 0,
          tokensReasoning: completion.tokensReasoning ?? 0,
          tokensCacheWrite: completion.tokensCacheWrite ?? 0,
          latencyMs: Date.now() - startedAt,
          cost: priced
            ? priced.cost
            : estimateLegacyCost(completion.tokensInput, completion.tokensOutput, completion.tokensCached ?? 0),
          priceSnapshot: priced
            ? { provider: provider.name, model: completion.model ?? provider.model, price: priced.price, source: priced.source }
            : {},
          errorMessage: null,
          requestedBy: params.meta.requestedBy ?? null,
          contentId: params.meta.contentId ?? null,
          contentVariantId: params.meta.contentVariantId ?? null,
        }),
      );
      return { result: parsed, generationId: generation.id, model: completion.model };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.generations.save(
        this.generations.create({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          provider: provider.name,
          model: provider.model,
          taskType: params.task,
          status: 'failed',
          prompt: params.user,
          output: null,
          inputRefs: params.meta.inputRefs ?? {},
          tokensInput: 0,
          tokensOutput: 0,
          latencyMs: Date.now() - startedAt,
          cost: '0',
          errorMessage: message,
          requestedBy: params.meta.requestedBy ?? null,
          contentId: params.meta.contentId ?? null,
          contentVariantId: params.meta.contentVariantId ?? null,
        }),
      );
      throw new BadGatewayException(`AI 服务调用失败：${message}`);
    }
  }

  /**
   * 额度保护：每分钟次数与每日 token 上限都可配置（设置 → AI 服务）。
   * 关闭限流（填 0）时不做任何查询，不增加正常开销。
   */
  private async assertWithinQuota(workspaceId: string): Promise<void> {
    const { rateLimitPerMinute, dailyTokenQuota } = runtime().ai;

    if (rateLimitPerMinute > 0) {
      const since = new Date(Date.now() - 60_000);
      const recent = await this.generations.count({ where: { workspaceId, createdAt: MoreThan(since) } });
      if (recent >= rateLimitPerMinute) {
        throw new HttpException(
          `AI 调用过于频繁：每分钟最多 ${rateLimitPerMinute} 次，请稍后再试（可在「设置 → AI 服务」调整）`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    if (dailyTokenQuota > 0) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const row = await this.generations
        .createQueryBuilder('generation')
        .select('COALESCE(SUM(generation.tokensInput + generation.tokensOutput), 0)', 'total')
        .where('generation.workspaceId = :workspaceId AND generation.createdAt >= :dayStart', { workspaceId, dayStart })
        .getRawOne<{ total: string }>();
      const used = Number(row?.total ?? 0);
      if (used >= dailyTokenQuota) {
        throw new HttpException(
          `今日 AI 额度已用完（已用 ${used} / 上限 ${dailyTokenQuota} token），明天自动恢复（可在「设置 → AI 服务」调整）`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  private parseVariants(text: string, requested: PlatformCode[]): AdaptedVariantPayload[] {
    const parsed = this.parseJson(text);
    const list = Array.isArray(parsed.variants) ? parsed.variants : [];
    const variants: AdaptedVariantPayload[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const platform = String(record.platform ?? '');
      if (!requested.includes(platform as PlatformCode)) continue;
      variants.push({
        platform,
        title: String(record.title ?? '').trim(),
        body: String(record.body ?? '').trim(),
        tags: Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : [],
      });
    }
    if (variants.length === 0) throw new Error('AI 未返回可用的平台版本');
    return variants;
  }

  private parseKnowledgeDraft(text: string): KnowledgeDraft {
    const parsed = this.parseJson(text);
    const content = String(parsed.content ?? '').trim();
    if (content.length < 20) throw new Error('AI 生成的条目内容过短，请补充要点后重试');
    return {
      title: String(parsed.title ?? '').trim().slice(0, 60) || content.slice(0, 24),
      content,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10) : [],
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.map((keyword) => String(keyword).trim()).filter(Boolean).slice(0, 10)
        : [],
    };
  }

  private parsePolished(text: string): string {
    const parsed = this.parseJson(text);
    const content = String(parsed.content ?? '').trim();
    if (content.length < 20) throw new Error('AI 未返回可用的润色结果');
    return content;
  }

  private parseTitles(text: string): string[] {
    const parsed = this.parseJson(text);
    const titles = Array.isArray(parsed.titles) ? parsed.titles.map((title) => String(title).trim()).filter(Boolean) : [];
    if (titles.length === 0) throw new Error('AI 未返回标题建议');
    return titles.slice(0, 3);
  }

  private parseReview(text: string): string {
    const parsed = this.parseJson(text);
    return typeof parsed.review === 'string' ? parsed.review : text.slice(0, 500);
  }

  /** Models sometimes wrap JSON in prose or code fences; salvage the object before failing. */
  private parseJson(text: string): Record<string, unknown> {
    const candidates = [text.trim()];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) candidates.push(fenced[1].trim());
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
      } catch {
        // try the next candidate
      }
    }
    throw new Error('AI 返回的内容不是合法 JSON');
  }
}
