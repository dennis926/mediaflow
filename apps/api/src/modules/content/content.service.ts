import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AiFlagType, ContentStatus, PlatformCode, appendAiDisclosure } from '@mediaflow/shared';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { AiService } from '../ai/ai.service';
import { AiAdaptDto } from '../ai/dto/ai.dto';
import { ContentVariant } from './entities/content-variant.entity';
import { Content } from './entities/content.entity';
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
}

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    @InjectRepository(ContentVariant) private readonly variants: Repository<ContentVariant>,
    private readonly aiService: AiService,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
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
      body: appendAiDisclosure(dto.body, aiFlagType),
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

    Object.assign(content, {
      title: dto.title ?? content.title,
      summary: dto.summary ?? content.summary,
      coverUrl: dto.coverUrl ?? content.coverUrl,
      mediaUrls: dto.mediaUrls ?? content.mediaUrls,
      tags: dto.tags ?? content.tags,
      status: dto.status ?? content.status,
      brandKnowledgeId: dto.brandKnowledgeId ?? content.brandKnowledgeId,
      aiFlagType,
      aiGenerated: aiFlagType !== AiFlagType.None,
      body: appendAiDisclosure(rawBody, aiFlagType),
    });

    const saved = await this.contents.save(content);
    await this.record(saved, 'content.update', actor, { aiFlagType });
    return saved;
  }

  /** Soft delete: the row is kept, only deleted_at is set, and it disappears from every query. */
  async remove(id: string, actor: ContentActor): Promise<{ id: string; deletedAt: Date }> {
    const content = await this.get(id);
    await this.contents.softDelete({ id: content.id });
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

    const adapted = await this.aiService.adapt(
      {
        title: content.title,
        body: content.body,
        tags: content.tags,
        platforms,
        tone: dto.tone,
        keywords: dto.keywords,
        aiFlagType: content.aiFlagType,
      },
      { contentId: content.id, requestedBy: actor.id ?? null },
    );

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
        extra: { model: adapted.model, tone: dto.tone ?? null, keywords: dto.keywords ?? [] },
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
      payload: { platforms, generated: saved.length, skipped, generationId: adapted.generationId },
    });

    if (skipped.length > 0 && saved.length === 0) {
      throw new ConflictException(`所选平台均已存在版本，如需覆盖请传 overwrite=true：${skipped.join(', ')}`);
    }

    this.logger.log(`AI 适配完成：新增/更新 ${saved.length} 个平台版本`);
    return {
      contentId: content.id,
      generationId: adapted.generationId,
      model: adapted.model,
      variants: saved,
      skipped,
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
