import { BadGatewayException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AiFlagType, PLATFORM_LABELS, PlatformCode } from '@mediaflow/shared';
import { FindOptionsWhere, Repository } from 'typeorm';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { AiGeneration } from './entities/ai-generation.entity';
import {
  AdaptedVariantPayload,
  AiCompletionResult,
  AiProvider,
  AiTaskType,
  ComplianceReport,
} from './ai.types';
import { checkCompliance, scoreViolations } from './compliance.rules';
import { AI_PROVIDER } from './ai.provider';

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
}

export interface ComplianceInput {
  text: string;
  platform?: PlatformCode;
  useAiReview?: boolean;
}

/** Keeps every prompt in one place so prompt changes are reviewable. */
const PLATFORM_GUIDANCE: Partial<Record<PlatformCode, string>> = {
  [PlatformCode.WechatMp]: '深度图文，可长文，标题 20 字以内，正文分段清晰，不做营销夸大',
  [PlatformCode.Douyin]: '短视频文案，口语化，前 3 秒抓住注意力，正文 100 字以内，结尾 3-5 个话题标签',
  [PlatformCode.Xiaohongshu]: '种草笔记，第一人称，emoji 适度，正文 300 字以内，结尾 5 个话题标签',
  [PlatformCode.WechatVideo]: '视频号口播稿，简洁口语，200 字以内',
  [PlatformCode.Zhihu]: '知乎回答风格，先给结论再论证，专业克制，不使用营销词',
  [PlatformCode.Toutiao]: '资讯风格，标题信息量大，正文 300-800 字',
  [PlatformCode.Baijiahao]: '图文资讯，结构清晰，小标题分节，300-800 字',
};

const SYSTEM_EDITOR = '你是资深中文新媒体编辑，服务食品与营养健康行业，严格遵守《广告法》与食品宣传合规要求，绝不出现疾病治疗、绝对化、承诺性表述。';
const SYSTEM_JSON = '只输出 JSON，不要输出任何解释文字或 Markdown 代码块。';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @InjectRepository(AiGeneration) private readonly generations: Repository<AiGeneration>,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  get modelName(): string {
    return this.provider.model;
  }

  async generate(prompt: string, tone: string | undefined, meta: AiInvocationMeta): Promise<{ text: string; generationId: string }> {
    const invocation = await this.invoke({
      task: 'generate',
      system: `${SYSTEM_EDITOR}${tone ? ` 语气要求：${tone}。` : ''}`,
      user: prompt,
      meta,
      parse: (completion) => completion.text,
    });
    return { text: invocation.result, generationId: invocation.generationId };
  }

  async adapt(input: AdaptInput, meta: AiInvocationMeta): Promise<{ variants: AdaptedVariantPayload[]; generationId: string; model: string }> {
    const guidance = input.platforms
      .map((platform) => `- ${PLATFORM_LABELS[platform]}(${platform})：${PLATFORM_GUIDANCE[platform] ?? '常规风格'}`)
      .join('\n');

    const invocation = await this.invoke({
      task: 'adapt',
      system: `${SYSTEM_EDITOR}${SYSTEM_JSON}`,
      json: true,
      user: [
        '请把以下内容改写为指定平台各自的版本，保留事实信息，不新增疗效描述。',
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
      meta: { ...meta, inputRefs: { ...meta.inputRefs, platforms: input.platforms } },
      parse: (completion) => this.parseVariants(completion.text, input.platforms),
    });

    return { variants: invocation.result, generationId: invocation.generationId, model: invocation.model };
  }

  async optimizeTitle(
    title: string,
    platform: PlatformCode | undefined,
    keywords: string[] | undefined,
    meta: AiInvocationMeta,
  ): Promise<{ titles: string[]; generationId: string }> {
    const invocation = await this.invoke({
      task: 'optimize_title',
      system: `${SYSTEM_EDITOR}${SYSTEM_JSON}`,
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
        system: `${SYSTEM_EDITOR}${SYSTEM_JSON}`,
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

    try {
      const completion = await this.provider.complete({
        task: params.task,
        system: params.system,
        user: params.user,
        json: params.json,
      });
      const parsed = params.parse(completion);
      const generation = await this.generations.save(
        this.generations.create({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          provider: this.provider.name,
          model: completion.model,
          taskType: params.task,
          status: 'success',
          prompt: params.user,
          output: completion.text,
          inputRefs: params.meta.inputRefs ?? {},
          tokensInput: completion.tokensInput,
          tokensOutput: completion.tokensOutput,
          latencyMs: Date.now() - startedAt,
          cost: '0',
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
          provider: this.provider.name,
          model: this.provider.model,
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

  private parseJson(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error('AI 返回的内容不是合法 JSON');
    }
  }
}
