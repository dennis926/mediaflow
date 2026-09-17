import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AiFlagType, PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { FindOptionsWhere, Repository } from 'typeorm';
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
import { estimateCost, runtime } from '../settings/runtime-config';

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
      this.logger.warn(`AI 合规复核不可用，已返回规则结果：${error instanceof Error ? error.message : String(error)}`);
    }
    return report;
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
          latencyMs: Date.now() - startedAt,
          cost: estimateCost(completion.tokensInput, completion.tokensOutput),
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
