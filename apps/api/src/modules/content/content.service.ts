import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AiFlagType, ContentStatus, PlatformCode, PublishTaskStatus, appendAiDisclosure } from '@mediaflow/shared';
import { runtime } from '../settings/runtime-config';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from './knowledge.service';
import { AiAdaptDto } from '../ai/dto/ai.dto';
import { ContentRevision } from './entities/content-revision.entity';
import { ContentVariant } from './entities/content-variant.entity';
import { Content } from './entities/content.entity';
import { ContentReview } from './entities/content-review.entity';
import { PublishTask } from '../publish/entities/publish-task.entity';
import type { KnowledgeMatch } from './knowledge.service';
import { AiFlagCheckDto, AiGenerateContentDto, CreateContentDto, QueryContentDto, UpdateContentDto } from './dto/content.dto';

export interface ContentActor {
  id?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ContentPage {
  items: Content[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface AdaptResult {
  contentId: string;
  generationId: string;
  model: string;
  variants: ContentVariant[];
  skipped: PlatformCode[];
  /** 本次生成引用的品牌资料（可解释 AI 为什么这么写）。 */
  knowledgeUsed: KnowledgeMatch[];
}

export interface ContentDraftResult {
  draft: { title: string; summary: string; body: string; tags: string[] };
  generationId: string;
  model: string;
  /** 本次生成引用的品牌资料；为空说明知识库里没有匹配资料（AI 会更自由发挥）。 */
  knowledgeUsed: KnowledgeMatch[];
}

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    @InjectRepository(ContentVariant) private readonly variants: Repository<ContentVariant>,
    @InjectRepository(ContentRevision) private readonly revisions: Repository<ContentRevision>,
    private readonly aiService: AiService,
    private readonly knowledgeService: KnowledgeService,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * B0.6：AI 标识一致性校验（法定要求）。
   *
   * 判定依据不是"用户填了什么"，而是**系统自己的证据**：`ai_generations` 里是否有这条内容的生成记录。
   * 若有记录却把标识填成 `none`，只有两条路：
   *   ① 没填理由 → **强制回填标识**（改成 assisted + 追加显式标识文案），并写审计 `content.ai_flag.backfilled`；
   *   ② 填了理由 → 保留 none，但理由必须留痕（审计 `content.ai_flag.exempted` 带理由与证据条数）。
   *
   * 调用点：内容创建/更新后，以及**审核通过前**（发布闸门的最后一道）。
   */
  async assertAiFlagConsistency(
    contentId: string,
    actor: ContentActor,
  ): Promise<{ flagged: boolean; evidence: number; aiFlagType: AiFlagType }> {
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({
      where: { id: contentId, tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    });
    if (!content) throw new NotFoundException('内容不存在');
    if (content.aiFlagType !== AiFlagType.None) {
      return { flagged: false, evidence: 0, aiFlagType: content.aiFlagType };
    }

    // 证据：这条内容是否有 AI 生成记录（来自 ai_generations，不依赖人工填写）
    const evidenceRows = await this.dataSource.query(
      'SELECT count(*)::int AS n FROM ai_generations WHERE content_id = $1 AND workspace_id = $2',
      [contentId, scope.workspaceId],
    );
    const evidence = Number(evidenceRows[0]?.n ?? 0);
    if (evidence === 0) return { flagged: false, evidence: 0, aiFlagType: AiFlagType.None };

    const reason = content.aiFlagExemptReason?.trim();
    if (reason) {
      await this.audit.record({
        action: 'content.ai_flag.exempted',
        resourceType: 'content',
        resourceId: content.id,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        payload: { evidence, reason, aiFlagType: AiFlagType.None },
      });
      return { flagged: false, evidence, aiFlagType: AiFlagType.None };
    }

    // 强制回填：标识改成 assisted，并把显式标识文案并入正文（法定显式标识）
    const body = appendAiDisclosure(content.body, AiFlagType.Assisted, runtime().site.aiDisclosureSuffix);
    await this.contents.update(
      { id: content.id },
      { aiFlagType: AiFlagType.Assisted, aiGenerated: true, body },
    );
    await this.audit.record({
      action: 'content.ai_flag.backfilled',
      resourceType: 'content',
      resourceId: content.id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { evidence, from: AiFlagType.None, to: AiFlagType.Assisted },
    });
    this.logger.warn(`内容缺少 AI 标识但存在 ${evidence} 条 AI 生成记录，已强制回填：${content.id}`);
    return { flagged: true, evidence, aiFlagType: AiFlagType.Assisted };
  }

  async create(dto: CreateContentDto, actor: ContentActor): Promise<Content> {
    const scope = await this.workspaceContext.current();
    const aiFlagType = dto.aiFlagType ?? AiFlagType.None;

    const entity = this.contents.create({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      title: dto.title,
      summary: dto.summary ?? null,
      // The legal AI mark is stored with the text, so every downstream consumer inherits it.
      body: appendAiDisclosure(dto.body, aiFlagType, runtime().site.aiDisclosureSuffix),
      coverUrl: dto.coverUrl ?? null,
      mediaUrls: dto.mediaUrls ?? [],
      tags: dto.tags ?? [],
      // 创建永远是草稿：状态只能由审批流/归档接口推进（审计 P1-1）
      status: ContentStatus.Draft,
      aiGenerated: aiFlagType !== AiFlagType.None,
      aiFlagType,
      aiFlagExemptReason: dto.aiFlagExemptReason?.trim() || null,
      aiFlagChecked: false,
      brandKnowledgeId: dto.brandKnowledgeId ?? null,
      authorId: actor.id ?? null,
      publishedAt: null,
    });

    const saved = await this.contents.save(entity);
    await this.record(saved, 'content.create', actor, { aiFlagType });
    this.logger.log(`已创建内容：${saved.title}`);
    return saved;
  }

  async list(query: QueryContentDto): Promise<ContentPage> {
    const scope = await this.workspaceContext.current();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const builder = this.contents.createQueryBuilder('content').where('content.workspaceId = :workspaceId', {
      workspaceId: scope.workspaceId,
    });

    if (query.status) builder.andWhere('content.status = :status', { status: query.status });
    if (typeof query.aiGenerated === 'boolean') builder.andWhere('content.aiGenerated = :aiGenerated', { aiGenerated: query.aiGenerated });
    if (query.keyword) {
      builder.andWhere('(content.title ILIKE :keyword OR content.summary ILIKE :keyword OR content.body ILIKE :keyword)', {
        keyword: `%${query.keyword}%`,
      });
    }
    if (query.platform) {
      builder.andWhere(
        'EXISTS (SELECT 1 FROM content_variants variant WHERE variant.content_id = content.id AND variant.platform = :platform)',
        { platform: query.platform },
      );
    }

    builder.orderBy('content.createdAt', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [items, total] = await builder.getManyAndCount();
    return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } };
  }

  async get(id: string): Promise<Content> {
    const scope = await this.workspaceContext.current();
    const content = await this.contents.findOne({
      where: { id, workspaceId: scope.workspaceId },
      relations: { variants: true },
      order: { variants: { createdAt: 'ASC' } },
    });
    if (!content) throw new NotFoundException('内容不存在');
    return content;
  }

  async update(id: string, dto: UpdateContentDto, actor: ContentActor): Promise<Content> {
    const content = await this.get(id);
    const aiFlagType = dto.aiFlagType ?? content.aiFlagType;
    const rawBody = dto.body ?? content.body;

    const previousStatus = content.status;
    /**
     * 影响发布内容的字段都算改动：早期只比较 title/body，导致"改标签/素材后仍算已审核"（审计 P2-1）。
     */
    const contentChanged =
      (dto.title !== undefined && dto.title !== content.title) ||
      (dto.body !== undefined && dto.body !== content.body) ||
      (dto.tags !== undefined && JSON.stringify(dto.tags) !== JSON.stringify(content.tags ?? [])) ||
      (dto.mediaUrls !== undefined && JSON.stringify(dto.mediaUrls) !== JSON.stringify(content.mediaUrls ?? [])) ||
      (dto.coverUrl !== undefined && (dto.coverUrl ?? null) !== (content.coverUrl ?? null));

    Object.assign(content, {
      title: dto.title ?? content.title,
      summary: dto.summary ?? content.summary,
      coverUrl: dto.coverUrl ?? content.coverUrl,
      mediaUrls: dto.mediaUrls ?? content.mediaUrls,
      tags: dto.tags ?? content.tags,
      brandKnowledgeId: dto.brandKnowledgeId ?? content.brandKnowledgeId,
      aiFlagType,
      aiGenerated: aiFlagType !== AiFlagType.None,
      body: appendAiDisclosure(rawBody, aiFlagType, runtime().site.aiDisclosureSuffix),
      // 审核通过后如果再改动（正文/标题/标签/素材），原审核结论失效，必须重新送审。
      // 客户端传的 status 已在 DTO 层移除，这里只保留服务端自己的状态机。
      status: contentChanged && previousStatus === ContentStatus.Approved ? ContentStatus.Draft : content.status,
    });

    // 保存前把"上一版"留档，改错可回滚（保留条数可配置）
    if (contentChanged) {
      await this.snapshot(content, actor, '编辑保存');
    }

    const saved = await this.contents.save(content);
    await this.record(saved, 'content.update', actor, {
      aiFlagType,
      ...(contentChanged && previousStatus === ContentStatus.Approved ? { reviewInvalidatedFrom: previousStatus } : {}),
    });
    if (contentChanged && previousStatus === ContentStatus.Approved) {
      this.logger.log(`内容已修改，审核结论失效并退回草稿：${saved.title}`);
    }
    return saved;
  }

  /** 把当前状态存成一条历史版本，并按配置裁剪超出的旧版本。 */
  private async snapshot(content: Content, actor: ContentActor, note: string): Promise<void> {
    const limit = runtime().media.contentHistoryLimit;
    if (limit <= 0) return;
    try {
      const scope = await this.workspaceContext.current();
      const latest = await this.revisions.findOne({
        where: { contentId: content.id },
        order: { version: 'DESC' },
      });
      await this.revisions.save(
        this.revisions.create({
          tenantId: content.tenantId ?? scope.tenantId,
          workspaceId: content.workspaceId ?? scope.workspaceId,
          contentId: content.id,
          version: (latest?.version ?? 0) + 1,
          title: content.title,
          summary: content.summary ?? null,
          body: content.body,
          tags: content.tags ?? [],
          mediaUrls: content.mediaUrls ?? [],
          coverUrl: content.coverUrl ?? null,
          aiFlagType: content.aiFlagType,
          status: content.status,
          note,
          createdBy: actor.id ?? null,
          createdByName: actor.name ?? null,
        }),
      );

      // 只保留最近 limit 条，避免历史无限增长
      const all = await this.revisions.find({ where: { contentId: content.id }, order: { version: 'DESC' } });
      const stale = all.slice(limit);
      if (stale.length > 0) {
        await this.revisions.remove(stale);
      }
    } catch (error) {
      // 历史留档失败不能影响正常保存
      this.logger.warn(`写入内容版本失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 版本历史列表（新到旧）。 */
  async listRevisions(contentId: string): Promise<ContentRevision[]> {
    await this.get(contentId);
    return this.revisions.find({ where: { contentId }, order: { version: 'DESC' }, take: 100 });
  }

  /** 回滚到指定版本：先把当前状态留一份，再套用旧版本内容（审核结论会退回草稿）。 */
  async restoreRevision(contentId: string, revisionId: string, actor: ContentActor): Promise<Content> {
    const content = await this.get(contentId);
    const revision = await this.revisions.findOne({ where: { id: revisionId, contentId } });  // tenant-scope-ok: 内容行先按 workspaceId 取到，此处按 contentId 级联子表
    if (!revision) throw new NotFoundException('历史版本不存在');

    await this.snapshot(content, actor, `恢复前留档（第 ${revision.version} 版）`);

    await this.contents.update(
      { id: contentId },
      {
        title: revision.title,
        summary: revision.summary,
        body: revision.body,
        tags: revision.tags,
        mediaUrls: revision.mediaUrls,
        coverUrl: revision.coverUrl,
        aiFlagType: revision.aiFlagType,
        aiGenerated: revision.aiFlagType !== AiFlagType.None,
        // 内容变了，之前的审核结论不再成立
        status: ContentStatus.Draft,
      },
    );
    await this.record(content, 'content.restore_revision', actor, { version: revision.version });
    this.logger.log(`内容 ${contentId} 已回滚到第 ${revision.version} 版`);
    return this.get(contentId);
  }

  /**
   * 批量操作：归档/取消归档/删除。
   * 返回成功数量与逐条失败原因，避免一条失败整批中断。
   */
  async batch(ids: string[], action: 'archive' | 'unarchive' | 'delete', actor: ContentActor): Promise<{ affected: number; failed: Array<{ id: string; reason: string }> }> {
    const failed: Array<{ id: string; reason: string }> = [];
    let affected = 0;
    for (const id of ids) {
      try {
        if (action === 'delete') await this.remove(id, actor);
        else await this.archive(id, action === 'archive', actor);
        affected += 1;
      } catch (error) {
        failed.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // 审计必须带真实租户/工作区，否则 uuid 转换失败会被静默吞掉（批量操作就查不到了）
    const scope = await this.workspaceContext.current();
    await this.audit.record({
      action: `content.batch_${action}`,
      resourceType: 'content',
      resourceId: ids[0] ?? null,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { total: ids.length, affected, failed: failed.length },
    });
    return { affected, failed };
  }

  /** Soft delete: the row is kept, only deleted_at is set, and it disappears from every query. */
  /**
   * 归档：内容不再参与发布与检索，但保留全部历史（比删除更温和、可随时恢复）。
   * 已发布过的稿件建议归档而不是删除，避免数据断链。
   */
  async archive(id: string, archived: boolean, actor: ContentActor): Promise<Content> {
    const content = await this.get(id);
    const previous = content.status;
    await this.contents.update(
      { id },
      { status: archived ? ContentStatus.Archived : ContentStatus.Draft },
    );

    // 归档=不再参与发布：把还没发出去的任务一并取消，避免队列里留着不会再执行的任务
    if (archived) {
      await this.dataSource
        .createQueryBuilder()
        .update(PublishTask)
        .set({ status: PublishTaskStatus.Canceled, finishedAt: new Date(), errorMessage: '内容已归档，任务自动取消' })
        .where('content_id = :contentId AND status IN (:...statuses)', {
          contentId: id,
          statuses: [PublishTaskStatus.Pending, PublishTaskStatus.Scheduled],
        })
        .execute();
    }
    await this.recordStatusChange(content, previous, archived ? ContentStatus.Archived : ContentStatus.Draft, archived ? '归档' : '取消归档', actor);
    await this.audit.record({
      action: archived ? 'content.archive' : 'content.unarchive',
      resourceType: 'content',
      resourceId: content.id,
      tenantId: content.tenantId,
      workspaceId: content.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { previousStatus: previous },
    });
    this.logger.log(`内容 ${content.id} 已${archived ? '归档' : '取消归档'}`);
    return this.get(id);
  }

  async remove(id: string, actor: ContentActor): Promise<{ id: string; deletedAt: Date }> {
    const content = await this.get(id);
    const deletedAt = new Date();

    /**
     * 级联清理，避免"幽灵数据"：
     * - 平台版本一并软删（否则统计与列表会漂移）；
     * - **未完成**的发布任务自动取消（内容都没了，任务队列里不该还留着待发布）；
     * - 待审核记录关闭，审核列表不再出现已删内容。
     * 已发布的任务保留（历史事实），仅标记来源内容已删除。
     */
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.softDelete(Content, { id: content.id });
      await manager.softDelete(ContentVariant, { contentId: content.id });
      await manager
        .createQueryBuilder()
        .update(PublishTask)
        .set({
          status: PublishTaskStatus.Canceled,
          finishedAt: deletedAt,
          errorMessage: '内容已被删除，任务自动取消',
          lockedBy: null,
          lockedAt: null,
        })
        .where('content_id = :contentId AND status IN (:...statuses)', {
          contentId: content.id,
          statuses: [PublishTaskStatus.Pending, PublishTaskStatus.Scheduled, PublishTaskStatus.ManualRequired, PublishTaskStatus.Failed],
        })
        .execute();
      await manager
        .createQueryBuilder()
        .update(ContentReview)
        .set({ status: 'changes_requested', comments: '内容已被删除，审核自动关闭', decidedAt: deletedAt })
        .where('content_id = :contentId AND status = :status', { contentId: content.id, status: 'pending' })
        .execute();
    });

    await this.record(content, 'content.delete', actor, { cascadedTasks: true });
    this.logger.log(`已软删除内容（含级联取消未完成任务）：${content.title}`);
    return { id: content.id, deletedAt };
  }

  async listVariants(contentId: string): Promise<ContentVariant[]> {
    const content = await this.get(contentId);
    return this.variants.find({ where: { contentId: content.id }, order: { platform: 'ASC' } });
  }

  async setAiFlagChecked(id: string, dto: AiFlagCheckDto, actor: ContentActor): Promise<Content> {
    const content = await this.get(id);
    content.aiFlagChecked = dto.checked;
    const saved = await this.contents.save(content);
    await this.record(saved, dto.checked ? 'content.ai_flag_checked' : 'content.ai_flag_unchecked', actor, {
      note: dto.note ?? null,
    });
    return saved;
  }

  /** Calls the AI service and persists one variant per requested platform. */
  /**
   * 「AI 一键生成」：给一个主题，AI 从零起草一篇内容，直接填进编辑器由人工确认。
   *
   * 与 `aiAdapt` 的分工：`aiAdapt` 改写**已保存**的正文成各平台版本；这里是从零起草，
   * 产物尚未入库（用户在编辑器里改完再点保存）。
   *
   * 品牌锚定与 `aiAdapt` 走同一条路（`findRelevant` + `buildPromptSection`）：
   * 让 AI 照着品牌资料写，而不是自由发挥；引用了哪些资料会一并返回，便于解释。
   */
  async aiGenerateDraft(dto: AiGenerateContentDto, actor: ContentActor): Promise<ContentDraftResult> {
    // 用主题 + 关键词做检索，命中品牌资料后作为硬约束注入 prompt
    const matches = await this.knowledgeService.findRelevant({
      title: dto.topic,
      tags: dto.keywords,
      brand: dto.brand,
      platform: dto.platform,
    });
    const knowledge = matches.length
      ? { ids: matches.map((match) => match.id), section: this.knowledgeService.buildPromptSection(matches) }
      : undefined;

    const generated = await this.aiService.generateContent(
      {
        topic: dto.topic,
        platform: dto.platform,
        tone: dto.tone,
        wordCount: dto.wordCount,
        keywords: dto.keywords,
        brand: dto.brand,
        knowledge,
      },
      {
        requestedBy: actor.id ?? null,
        inputRefs: {
          topic: dto.topic,
          ...(dto.platform ? { platforms: [dto.platform] } : {}),
          ...(knowledge?.ids.length ? { knowledgeIds: knowledge.ids } : {}),
        },
      },
    );
    await this.knowledgeService.markUsed(knowledge?.ids ?? []);

    const scope = await this.workspaceContext.current();
    await this.audit.record({
      action: 'content.ai_draft',
      resourceType: 'content',
      resourceId: null,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      payload: {
        topic: dto.topic,
        platform: dto.platform ?? null,
        generationId: generated.generationId,
        knowledgeUsed: matches.map((match) => match.title),
      },
    });

    return {
      draft: generated.draft,
      generationId: generated.generationId,
      model: generated.model,
      knowledgeUsed: matches,
    };
  }

  async aiAdapt(contentId: string, dto: AiAdaptDto, actor: ContentActor): Promise<AdaptResult> {
    const content = await this.get(contentId);
    const platforms = [...new Set(dto.platforms)];

    // Fail before spending an AI call when every requested platform already has a variant.
    if (!dto.overwrite) {
      const existing = await this.variants.find({ where: { contentId: content.id } });
      const existingPlatforms = new Set(existing.map((variant) => variant.platform));
      const alreadyCovered = platforms.filter((platform) => existingPlatforms.has(platform));
      if (alreadyCovered.length === platforms.length) {
        throw new ConflictException(
          `所选平台均已存在版本，如需覆盖请传 overwrite=true：${alreadyCovered.join(', ')}`,
        );
      }
    }

    // 生成前先捞出相关品牌资料：让 AI 用品牌口径写，而不是自由发挥。
    const matches = await this.knowledgeService.findRelevant({
      title: content.title,
      body: content.body,
      tags: content.tags,
      brand: (content as unknown as { brand?: string }).brand,
      platform: platforms[0],
    });
    const knowledge = matches.length
      ? { ids: matches.map((match) => match.id), section: this.knowledgeService.buildPromptSection(matches) }
      : undefined;

    const adapted = await this.aiService.adapt(
      {
        title: content.title,
        body: content.body,
        tags: content.tags,
        platforms,
        tone: dto.tone,
        keywords: dto.keywords,
        aiFlagType: content.aiFlagType,
        knowledge,
      },
      { contentId: content.id, requestedBy: actor.id ?? null },
    );
    await this.knowledgeService.markUsed(knowledge?.ids ?? []);

    const variantFlag: AiFlagType =
      content.aiFlagType === AiFlagType.None ? AiFlagType.Assisted : content.aiFlagType;

    const saved: ContentVariant[] = [];
    const skipped: PlatformCode[] = [];

    for (const variant of adapted.variants) {
      const platform = variant.platform as PlatformCode;
      const existing = await this.variants.findOne({ where: { contentId: content.id, platform } });
      if (existing && !dto.overwrite) {
        skipped.push(platform);
        continue;
      }

      const payload = {
        tenantId: content.tenantId,
        workspaceId: content.workspaceId,
        contentId: content.id,
        platform,
        title: variant.title,
        body: appendAiDisclosure(variant.body, variantFlag),
        tags: variant.tags,
        mediaUrls: content.mediaUrls,
        status: ContentStatus.Draft,
        aiGenerated: true,
        aiFlagType: variantFlag,
        generationId: adapted.generationId,
        extra: {
          model: adapted.model,
          tone: dto.tone ?? null,
          keywords: dto.keywords ?? [],
          knowledgeIds: knowledge?.ids ?? [],
        },
      };

      const entity = existing ? Object.assign(existing, payload) : this.variants.create(payload);
      saved.push(await this.variants.save(entity));
    }

    await this.audit.record({
      action: 'content.ai_adapt',
      resourceType: 'content',
      resourceId: content.id,
      tenantId: content.tenantId,
      workspaceId: content.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      payload: {
        platforms,
        generated: saved.length,
        skipped,
        generationId: adapted.generationId,
        knowledgeIds: knowledge?.ids ?? [],
      },
    });

    if (skipped.length > 0 && saved.length === 0) {
      throw new ConflictException(`所选平台均已存在版本，如需覆盖请传 overwrite=true：${skipped.join(', ')}`);
    }

    this.logger.log(
      `AI 适配完成：新增/更新 ${saved.length} 个平台版本${knowledge ? `（引用品牌资料 ${knowledge.ids.length} 条）` : ''}`,
    );
    return {
      contentId: content.id,
      generationId: adapted.generationId,
      model: adapted.model,
      variants: saved,
      skipped,
      knowledgeUsed: matches,
    };
  }

  /**
   * 状态迁移统一留痕：任何状态变化都写 content.status_change（含 from/to/reason），
   * 便于回答"这条内容为什么是已审核/已归档"（审计要求：状态迁移可追溯）。
   */
  private async recordStatusChange(
    content: Content,
    from: string,
    to: string,
    reason: string,
    actor: ContentActor,
  ): Promise<void> {
    if (from === to) return;
    await this.record(content, 'content.status_change', actor, { from, to, reason });
  }

  private async record(content: Content, action: string, actor: ContentActor, payload: Record<string, unknown>): Promise<void> {
    await this.audit.record({
      action,
      resourceType: 'content',
      resourceId: content.id,
      tenantId: content.tenantId,
      workspaceId: content.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      payload: { title: content.title, status: content.status, ...payload },
    });
  }
}
