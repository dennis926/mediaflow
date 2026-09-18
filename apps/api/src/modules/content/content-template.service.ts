import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { ContentTemplate } from './entities/content-template.entity';

export interface TemplateActor {
  id?: string | null;
  name?: string | null;
}

export interface TemplateInput {
  name: string;
  description?: string | null;
  platform?: string | null;
  category?: string | null;
  title: string;
  body: string;
  tags?: string[];
  isActive?: boolean;
}

export interface TemplatePage {
  items: ContentTemplate[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * 文案模板库：把常用写法沉淀下来复用，避免每次都从空白开始。
 * 模板属于内容（可增删改），不是代码里的硬编码。
 */
@Injectable()
export class ContentTemplateService {
  private readonly logger = new Logger(ContentTemplateService.name);

  constructor(
    @InjectRepository(ContentTemplate) private readonly templates: Repository<ContentTemplate>,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
  ) {}

  async list(query: { keyword?: string; platform?: string; category?: string; page?: number; pageSize?: number }): Promise<TemplatePage> {
    const scope = await this.workspaceContext.current();
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 20;

    const builder = this.templates
      .createQueryBuilder('template')
      .where('template.workspaceId = :workspaceId AND template.deletedAt IS NULL', { workspaceId: scope.workspaceId });
    if (query.keyword) {
      builder.andWhere('(template.name ILIKE :kw OR template.title ILIKE :kw OR template.body ILIKE :kw OR template.tags::text ILIKE :kw)', {
        kw: `%${query.keyword}%`,
      });
    }
    if (query.platform) builder.andWhere('(template.platform = :platform OR template.platform IS NULL)', { platform: query.platform });
    if (query.category) builder.andWhere('template.category = :category', { category: query.category });

    const [items, total] = await builder
      .orderBy('template.usageCount', 'DESC')
      .addOrderBy('template.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } };
  }

  /** 分类清单（筛选下拉用）。 */
  async categories(): Promise<Array<{ category: string; count: number }>> {
    const scope = await this.workspaceContext.current();
    const rows = await this.templates
      .createQueryBuilder('template')
      .select('template.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('template.workspaceId = :workspaceId AND template.deletedAt IS NULL AND template.category IS NOT NULL', {
        workspaceId: scope.workspaceId,
      })
      .groupBy('template.category')
      .orderBy('count', 'DESC')
      .getRawMany<{ category: string; count: number }>();
    return rows.map((row) => ({ category: row.category, count: Number(row.count) }));
  }

  async get(id: string): Promise<ContentTemplate> {
    const scope = await this.workspaceContext.current();
    const template = await this.templates.findOne({ where: { id, workspaceId: scope.workspaceId, deletedAt: IsNull() } });
    if (!template) throw new NotFoundException('模板不存在或已删除');
    return template;
  }

  async create(input: TemplateInput, actor: TemplateActor): Promise<ContentTemplate> {
    const scope = await this.workspaceContext.current();
    const saved = await this.templates.save(
      this.templates.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        platform: input.platform?.trim() || null,
        category: input.category?.trim() || null,
        title: input.title,
        body: input.body,
        tags: input.tags ?? [],
        isActive: input.isActive ?? true,
        usageCount: 0,
        lastUsedAt: null,
        createdBy: actor.id ?? null,
        createdByName: actor.name ?? null,
        deletedAt: null,
      }),
    );
    await this.record('content_template.create', saved.id, actor, { name: saved.name });
    return saved;
  }

  async update(id: string, input: Partial<TemplateInput>, actor: TemplateActor): Promise<ContentTemplate> {
    const template = await this.get(id);
    await this.templates.update(
      { id },
      {
        name: input.name?.trim() ?? template.name,
        description: input.description === undefined ? template.description : input.description?.trim() || null,
        platform: input.platform === undefined ? template.platform : input.platform?.trim() || null,
        category: input.category === undefined ? template.category : input.category?.trim() || null,
        title: input.title ?? template.title,
        body: input.body ?? template.body,
        tags: input.tags ?? template.tags,
        isActive: input.isActive ?? template.isActive,
      },
    );
    await this.record('content_template.update', id, actor, { name: input.name ?? template.name });
    return this.get(id);
  }

  async remove(id: string, actor: TemplateActor): Promise<{ id: string }> {
    const template = await this.get(id);
    await this.templates.update({ id }, { deletedAt: new Date() });
    await this.record('content_template.delete', id, actor, { name: template.name });
    return { id };
  }

  /** 使用一次：累加引用次数并返回模板内容（前端据此预填编辑器）。 */
  async use(id: string): Promise<ContentTemplate> {
    const template = await this.get(id);
    if (!template.isActive) throw new BadRequestException('该模板已停用');
    await this.templates.update({ id }, { usageCount: template.usageCount + 1, lastUsedAt: new Date() });
    this.logger.log(`模板被使用：${template.name}`);
    return { ...template, usageCount: template.usageCount + 1 };
  }

  private async record(action: string, id: string, actor: TemplateActor, payload: Record<string, unknown>): Promise<void> {
    const scope = await this.workspaceContext.current();
    await this.audit.record({
      action,
      resourceType: 'content_template',
      resourceId: id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload,
    });
  }
}
