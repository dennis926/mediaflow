import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AiFlagType, ContentStatus, PlatformCode, appendAiDisclosure } from '@mediaflow/shared';
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
import type { KnowledgeMatch } from './knowledge.service';
import { AiFlagCheckDto, CreateContentDto, QueryContentDto, UpdateContentDto } from './dto/content.dto';

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
      status: dto.status ?? ContentStatus.Draft,
      aiGenerated: aiFlagType !== AiFlagType.None,
      aiFlagType,
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
    const contentChanged =
      (dto.title !== undefined && dto.title !== content.title) || (dto.body !== undefined && dto.body !== content.body);

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
      // 审核通过后如果正文/标题又被改了，原审核结论失效，必须重新送审。
      status: contentChanged && previousStatus === ContentStatus.Approved ? ContentStatus.Draft : (dto.status ?? content.status),
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
    const revision = await this.revisions.findOne({ where: { id: revisionId, contentId } });
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
    // 级联软删平台版本，避免内容删了但版本还留在库里造成统计漂移。
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.softDelete(Content, { id: content.id });
      await manager.softDelete(ContentVariant, { contentId: content.id });
    });
    await this.record(content, 'content.delete', actor, {});
    const deletedAt = new Date();
    this.logger.log(`已软删除内容：${content.title}`);
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
