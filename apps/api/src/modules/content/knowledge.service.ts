import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PlatformCode } from '@mediaflow/shared';
import { In, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { CreateKnowledgeDto, QueryKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';
import { BrandKnowledge, KnowledgeCategory } from './entities/brand-knowledge.entity';
import { Content } from './entities/content.entity';

export interface KnowledgePage {
  items: BrandKnowledge[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface KnowledgeMatch {
  id: string;
  brand: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  /** 命中原因，界面上可解释"为什么引用它"。 */
  matchedBy: string[];
  score: number;
}

export interface KnowledgeActor {
  id?: string | null;
  name?: string | null;
}

/** 每次生成最多注入多少条品牌资料（太多会稀释重点、推高 token）。 */
const DEFAULT_LIMIT = 5;

/**
 * 品牌知识库。
 *
 * 设计要点：
 * 1. 检索走"关键词/标签子串匹配 + 优先级 + 历史引用次数"，中文不做分词，避免误切；
 * 2. 只会把 isActive 的资料喂给 AI，停用即刻生效；
 * 3. 每次引用都累加 usageCount / lastUsedAt，让真正有用的资料浮上来；
 * 4. 引用明细写进 ai_generations.inputRefs，回答"AI 为什么这么写"。
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @InjectRepository(BrandKnowledge) private readonly knowledge: Repository<BrandKnowledge>,
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  async list(query: QueryKnowledgeDto): Promise<KnowledgePage> {
    const scope = await this.workspaceContext.current();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const builder = this.knowledge
      .createQueryBuilder('knowledge')
      .where('knowledge.workspaceId = :workspaceId', { workspaceId: scope.workspaceId });

    if (query.keyword) {
      builder.andWhere(
        '(knowledge.title ILIKE :kw OR knowledge.content ILIKE :kw OR knowledge.brand ILIKE :kw)',
        { kw: `%${query.keyword}%` },
      );
    }
    if (query.brand) builder.andWhere('knowledge.brand = :brand', { brand: query.brand });
    if (query.category) builder.andWhere('knowledge.category = :category', { category: query.category });
    if (query.isActive) builder.andWhere('knowledge.isActive = :isActive', { isActive: query.isActive === 'true' });

    builder.orderBy('knowledge.priority', 'DESC').addOrderBy('knowledge.updatedAt', 'DESC')
      .skip((page - 1) * pageSize).take(pageSize);
    const [items, total] = await builder.getManyAndCount();
    return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } };
  }

  async brands(): Promise<Array<{ brand: string; count: number }>> {
    const scope = await this.workspaceContext.current();
    const rows = await this.knowledge
      .createQueryBuilder('knowledge')
      .select('knowledge.brand', 'brand')
      .addSelect('COUNT(*)', 'count')
      .where('knowledge.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .groupBy('knowledge.brand')
      .orderBy('count', 'DESC')
      .getRawMany<{ brand: string; count: string }>();
    return rows.map((row) => ({ brand: row.brand, count: Number(row.count) }));
  }

  async get(id: string): Promise<BrandKnowledge> {
    const scope = await this.workspaceContext.current();
    const item = await this.knowledge.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!item) throw new NotFoundException('品牌资料不存在');
    return item;
  }

  async create(dto: CreateKnowledgeDto, actor: KnowledgeActor): Promise<BrandKnowledge> {
    const scope = await this.workspaceContext.current();
    const saved = await this.knowledge.save(
      this.knowledge.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        brand: dto.brand,
        category: dto.category,
        title: dto.title,
        content: dto.content,
        tags: dto.tags ?? [],
        keywords: dto.keywords ?? [],
        priority: dto.priority ?? 0,
        platforms: dto.platforms ?? [],
        sourceUrl: dto.sourceUrl ?? null,
        isActive: true,
        usageCount: 0,
        lastUsedAt: null,
      }),
    );
    await this.record('knowledge.create', saved.id, actor, { brand: saved.brand, category: saved.category, title: saved.title });
    return saved;
  }

  async update(id: string, dto: UpdateKnowledgeDto, actor: KnowledgeActor): Promise<BrandKnowledge> {
    const item = await this.get(id);
    Object.assign(item, {
      brand: dto.brand ?? item.brand,
      category: dto.category ?? item.category,
      title: dto.title ?? item.title,
      content: dto.content ?? item.content,
      tags: dto.tags ?? item.tags,
      keywords: dto.keywords ?? item.keywords,
      priority: dto.priority ?? item.priority,
      platforms: dto.platforms ?? item.platforms,
      sourceUrl: dto.sourceUrl ?? item.sourceUrl,
      isActive: dto.isActive ?? item.isActive,
    });
    const saved = await this.knowledge.save(item);
    await this.record('knowledge.update', saved.id, actor, { title: saved.title, isActive: saved.isActive });
    return saved;
  }

  async remove(id: string, actor: KnowledgeActor): Promise<{ id: string }> {
    const item = await this.get(id);
    await this.knowledge.softDelete({ id: item.id });
    await this.record('knowledge.delete', item.id, actor, { title: item.title });
    return { id: item.id };
  }

  /**
   * 按内容（标题/正文/标签）检索最相关的品牌资料。
   * 匹配维度：品牌名、标题、标签、关键词与正文的子串交集；得分 = 命中数 × 权重 + priority 微调。
   */
  async findRelevant(
    input: { title: string; body?: string; tags?: string[]; brand?: string; platform?: PlatformCode },
    limit = DEFAULT_LIMIT,
  ): Promise<KnowledgeMatch[]> {
    const scope = await this.workspaceContext.current();
    const pool = await this.knowledge.find({
      where: { workspaceId: scope.workspaceId, isActive: true },
      order: { priority: 'DESC', usageCount: 'DESC' },
      take: 200,
    });
    if (pool.length === 0) return [];

    const haystack = `${input.title}\n${input.body ?? ''}\n${(input.tags ?? []).join(' ')}`.toLowerCase();
    const contentTags = (input.tags ?? []).map((tag) => tag.toLowerCase());

    const scored = pool
      .filter((item) => item.platforms.length === 0 || !input.platform || item.platforms.includes(input.platform))
      .map((item) => {
        const matchedBy: string[] = [];
        const needles = [...new Set([...item.tags, ...item.keywords, item.brand])].filter((value) => value && value.length >= 2);

        for (const needle of needles) {
          const lower = needle.toLowerCase();
          if (contentTags.includes(lower)) matchedBy.push(`标签命中：${needle}`);
          else if (haystack.includes(lower)) matchedBy.push(`正文命中：${needle}`);
        }
        if (input.brand && item.brand === input.brand && !matchedBy.some((entry) => entry.includes('品牌'))) {
          matchedBy.push(`品牌指定：${item.brand}`);
        }

        // 得分：命中维度越多越靠前，priority 作为同分时的加权，引用次数做轻微倾斜
        const score = matchedBy.length * 10 + Math.min(item.priority, 10) + Math.min(item.usageCount, 20) * 0.1;
        return { item, matchedBy, score };
      })
      .filter((entry) => entry.matchedBy.length > 0 || entry.item.priority >= 8)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return scored.map((entry) => ({
      id: entry.item.id,
      brand: entry.item.brand,
      category: entry.item.category,
      title: entry.item.title,
      content: entry.item.content,
      matchedBy: entry.matchedBy.length > 0 ? entry.matchedBy : ['高优先级通用资料'],
      score: Number(entry.score.toFixed(2)),
    }));
  }

  /** 针对某个内容预览"这次生成会引用哪些资料"，让运营在生成前就能确认。 */
  async previewForContent(contentId: string, platform?: PlatformCode, limit = DEFAULT_LIMIT): Promise<{ matches: KnowledgeMatch[] }> {
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({ where: { id: contentId, workspaceId: scope.workspaceId } });
    if (!content) throw new NotFoundException('内容不存在');
    return { matches: await this.findRelevant({ title: content.title, body: content.body, tags: content.tags, platform }, limit) };
  }

  /** 把资料拼成一段可注入 prompt 的文本（英文注释、中文内容）。 */
  buildPromptSection(matches: KnowledgeMatch[]): string {
    if (matches.length === 0) return '';
    const lines = matches.map(
      (match, index) => `${index + 1}. 【${match.brand}·${match.category}】${match.title}\n${match.content}`,
    );
    return [
      '以下是品牌方提供的资料，生成内容时必须遵守（不得编造资料中没有的功效、成分或认证）：',
      ...lines,
    ].join('\n');
  }

  /** 生成完成后记账，供知识库自己沉淀。 */
  async markUsed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.knowledge
      .createQueryBuilder()
      .update(BrandKnowledge)
      .set({ usageCount: () => '"usage_count" + 1', lastUsedAt: () => 'now()' })
      .where('id IN (:...ids)', { ids })
      .execute()
      .catch((error: unknown) =>
        this.logger.warn(`更新资料引用次数失败：${error instanceof Error ? error.message : String(error)}`),
      );
  }

  async findByIds(ids: string[]): Promise<BrandKnowledge[]> {
    if (ids.length === 0) return [];
    const scope = await this.workspaceContext.current();
    return this.knowledge.find({ where: { id: In(ids), workspaceId: scope.workspaceId } });
  }

  private async record(action: string, id: string, actor: KnowledgeActor, payload: Record<string, unknown>): Promise<void> {
    const scope = await this.workspaceContext.current();
    await this.audit.record({
      action,
      resourceType: 'brand_knowledge',
      resourceId: id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload,
    });
  }
}
