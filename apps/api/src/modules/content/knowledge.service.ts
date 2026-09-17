import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PlatformCode } from '@mediaflow/shared';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { In, Repository } from 'typeorm';
import {
  ExportFormat,
  FieldMapping,
  KnowledgeTransferService,
  MAPPING_TARGETS,
  ParsedTable,
  TransferEntry,
  TARGET_LABELS,
  autoMapColumns,
} from './knowledge.transfer.service';
import { AiService } from '../ai/ai.service';
import { KnowledgeDraft } from '../ai/ai.types';
import { AuditService } from '../../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import {
  CATEGORY_SETTING_KEY,
  KnowledgeCategoryDef,
  normalizeCategories,
  parseStoredCategories,
  setCategoryCodes,
} from './knowledge.categories';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import {
  AiGenerateKnowledgeDto,
  AiPolishKnowledgeDto,
  BatchActivateDto,
  BatchDeleteKnowledgeDto,
  CommitImportDto,
  MatchKnowledgeDto,
  SaveCategoriesDto,
  CreateKnowledgeDto,
  ImportKnowledgeDto,
  QueryKnowledgeDto,
  UpdateKnowledgeDto,
} from './dto/knowledge.dto';
import { DocumentParserService, KnowledgeChunk, ParsedDocument } from './document-parser.service';
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

export interface KnowledgeAuditIssue {
  id: string;
  title: string;
  brand: string;
  kind: 'too_short' | 'too_long' | 'no_tags' | 'never_used';
  detail: string;
}

export interface KnowledgeAuditReport {
  summary: {
    total: number;
    active: number;
    inactive: number;
    neverUsed: number;
    aiGenerated: number;
    duplicateGroups: number;
    checkedAt: string;
  };
  duplicateGroups: Array<{ similarity: number; items: Array<{ id: string; title: string; brand: string }> }>;
  issues: KnowledgeAuditIssue[];
}

export interface KnowledgeSourceGroup {
  sourceUrl: string;
  fileName: string;
  count: number;
  activeCount: number;
  lastCreatedAt: string;
  ids: string[];
}

export interface KnowledgeActor {
  id?: string | null;
  name?: string | null;
}

/** 从留档路径取原始文件名（去掉时间戳前缀）。 */
export function sourceFileName(sourceUrl: string): string {
  const name = sourceUrl.split('/').pop() ?? sourceUrl;
  return name.replace(/^\d{10,}-/, '');
}

/** 单次导入最多落库的资料片数（防止一份大文档灌爆知识库）。 */
const MAX_IMPORT_CHUNKS = 40;
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
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @InjectRepository(BrandKnowledge) private readonly knowledge: Repository<BrandKnowledge>,
    @InjectRepository(Content) private readonly contents: Repository<Content>,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly parser: DocumentParserService,
    private readonly ai: AiService,
    private readonly settings: SettingsService,
    private readonly transfer: KnowledgeTransferService,
  ) {}

  /** 上传目录：源文件留档，便于追溯每片资料来自哪个文档。 */
  private readonly uploadDir = join(process.cwd(), '../../uploads/knowledge');
  /** 复核阶段的暂存区：确认入库后才移入 uploads/knowledge，超期自动清理。 */
  private readonly tempDir = join(process.cwd(), '../../uploads/tmp');
  private readonly tempTtlMs = 24 * 60 * 60 * 1000;

  /**
   * multer/busboy 按 latin1 解析 multipart 文件名，中文会变乱码；
   * 这里按 UTF-8 重新解码一次（典型表现：出现 Ã/å 这类字符）。
   */
  static normalizeFileName(name: string): string {
    if (!/[\u0080-\u00ff]/.test(name)) return name;
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  }

  async list(query: QueryKnowledgeDto): Promise<KnowledgePage> {
    const scope = await this.workspaceContext.current();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const builder = this.knowledge
      .createQueryBuilder('knowledge')
      .where('knowledge.workspaceId = :workspaceId', { workspaceId: scope.workspaceId });

    if (query.keyword) {
      builder.andWhere(
        // 标签也参与搜索：导入的资料带「来源：文件名」，按文件名即可找回这一批
        "(knowledge.title ILIKE :kw OR knowledge.content ILIKE :kw OR knowledge.brand ILIKE :kw OR knowledge.tags::text ILIKE :kw)",
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
        aiGenerated: dto.aiGenerated ?? false,
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
      aiGenerated: dto.aiGenerated ?? item.aiGenerated,
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

  /**
   * 第一步：只解析、不入库。把切片结果交给前端做人工校对，原文件暂存到 uploads/tmp。
   */
  async parseDocument(file: { originalname: string; buffer: Buffer; size: number }): Promise<{
    parsed: Pick<ParsedDocument, 'fileName' | 'fileType' | 'charCount' | 'warnings' | 'ocrSections'>;
    tempFile: string;
    chunks: KnowledgeChunk[];
  }> {
    const fileName = KnowledgeService.normalizeFileName(file.originalname);
    const parsed = await this.parser.parse(fileName, file.buffer);
    const chunks = this.parser.chunkSegments(parsed.segments, MAX_IMPORT_CHUNKS);

    this.pruneTempFiles();
    mkdirSync(this.tempDir, { recursive: true });
    const tempFile = `${Date.now()}-${KnowledgeService.safeFileName(fileName)}`;
    writeFileSync(join(this.tempDir, tempFile), file.buffer);

    return {
      parsed: {
        fileName: parsed.fileName,
        fileType: parsed.fileType,
        charCount: parsed.charCount,
        warnings: parsed.warnings,
        ocrSections: parsed.ocrSections,
      },
      tempFile,
      chunks,
    };
  }

  /**
   * 第三步：按人工校对后的分片入库（用户点"确认无误"后调用）。
   * 以提交内容为准，不再重新解析原文；暂存的原文件此刻移入留档目录。
   */
  async commitImport(dto: CommitImportDto, actor: KnowledgeActor): Promise<{
    created: Array<{ id: string; title: string; isActive: boolean }>;
    storedPath: string | null;
  }> {
    const scope = await this.workspaceContext.current();
    const storedPath = dto.tempFile ? this.archiveTempFile(dto.tempFile) : null;

    const created = await this.persistChunks(
      {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        brand: dto.brand,
        category: dto.category,
        priority: dto.priority ?? 0,
        isActive: dto.activate ?? true,
        sourceFileName: dto.sourceFileName,
        sourceUrl: storedPath,
        chunks: dto.chunks,
      },
    );

    await this.record('knowledge.commit_import', created[0]?.id ?? '', actor, {
      fileName: dto.sourceFileName ?? '',
      chunks: created.length,
      activated: dto.activate ?? true,
      ocrChunks: dto.chunks.filter((chunk) => chunk.fromOcr === true).length,
    });
    this.logger.log(`文档入库（人工已确认）：${dto.sourceFileName ?? '未命名'} → ${created.length} 片`);
    return { created, storedPath };
  }

  /**
   * 旧接口：解析后直接入库（跳过人工校对）。保留给脚本/接口调用方，界面默认走"解析 → 校对 → 提交"。
   */
  async importDocument(
    file: { originalname: string; buffer: Buffer; size: number },
    dto: ImportKnowledgeDto,
    actor: KnowledgeActor,
  ): Promise<{
    parsed: Pick<ParsedDocument, 'fileName' | 'fileType' | 'charCount' | 'warnings' | 'ocrSections'>;
    storedPath: string;
    chunks: Array<KnowledgeChunk & { preview: string }>;
    created: Array<{ id: string; title: string; isActive: boolean }>;
  }> {
    const scope = await this.workspaceContext.current();
    const fileName = KnowledgeService.normalizeFileName(file.originalname);
    const parsed = await this.parser.parse(fileName, file.buffer);
    const chunks = this.parser.chunkSegments(parsed.segments, dto.maxChunks ?? MAX_IMPORT_CHUNKS);

    mkdirSync(this.uploadDir, { recursive: true });
    const storedName = `${Date.now()}-${KnowledgeService.safeFileName(fileName)}`;
    writeFileSync(join(this.uploadDir, storedName), file.buffer);

    const autoActivate = dto.autoActivate ?? false;
    const created = await this.persistChunks(
      {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        brand: dto.brand,
        category: dto.category,
        priority: dto.priority ?? 0,
        isActive: autoActivate,
        sourceFileName: parsed.fileName,
        sourceUrl: `uploads/knowledge/${storedName}`,
        chunks,
      },
    );

    await this.record('knowledge.import', created[0]?.id ?? '', actor, {
      fileName: parsed.fileName,
      fileType: parsed.fileType,
      charCount: parsed.charCount,
      chunks: chunks.length,
      autoActivate,
    });
    this.logger.log(`文档导入完成（未校对）：${parsed.fileName} → ${chunks.length} 片（${autoActivate ? '已启用' : '草稿待确认'}）`);

    return {
      parsed: {
        fileName: parsed.fileName,
        fileType: parsed.fileType,
        charCount: parsed.charCount,
        warnings: parsed.warnings,
        ocrSections: parsed.ocrSections,
      },
      storedPath: `uploads/knowledge/${storedName}`,
      chunks: chunks.map((chunk) => ({ ...chunk, preview: chunk.content.slice(0, 120) })),
      created,
    };
  }

  /** 统一的落库逻辑：一份分片 → 一条资料。 */
  private async persistChunks(
    input: {
      tenantId: string;
      workspaceId: string;
      brand: string;
      category: BrandKnowledge['category'];
      priority: number;
      isActive: boolean;
      sourceFileName?: string;
      sourceUrl: string | null;
      chunks: Array<{ title?: string; content: string; fromOcr?: boolean }>;
    },
  ): Promise<Array<{ id: string; title: string; isActive: boolean }>> {
    const tags = input.sourceFileName
      ? [`来源：${input.sourceFileName}`, ...(input.chunks.some((chunk) => chunk.fromOcr) ? ['含图片识别内容'] : [])]
      : [];

    const created: Array<{ id: string; title: string; isActive: boolean }> = [];
    for (const chunk of input.chunks) {
      const content = chunk.content.trim();
      if (content.length < 20) continue;
      const saved = await this.knowledge.save(
        this.knowledge.create({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          brand: input.brand,
          category: input.category,
          title: KnowledgeService.deriveTitle(chunk.title, content),
          content,
          tags,
          keywords: [],
          priority: input.priority,
          platforms: [],
          sourceUrl: input.sourceUrl ?? '',
          isActive: input.isActive,
          usageCount: 0,
          lastUsedAt: null,
        }),
      );
      created.push({ id: saved.id, title: saved.title, isActive: saved.isActive });
    }

    if (created.length === 0) {
      throw new BadRequestException('没有可入库的内容（每片至少 20 字）');
    }
    return created;
  }

  /** 把暂存文件移入留档目录；文件名非法或已过期时返回 null（不影响入库）。 */
  private archiveTempFile(tempFile: string): string | null {
    const name = basename(tempFile);
    if (name !== tempFile || !/^[\w.\u4e00-\u9fa5-]+$/.test(name)) {
      throw new BadRequestException('暂存文件标识不合法');
    }
    const source = join(this.tempDir, name);
    if (!existsSync(source)) {
      this.logger.warn(`暂存文件已过期，未留档：${name}`);
      return null;
    }
    mkdirSync(this.uploadDir, { recursive: true });
    renameSync(source, join(this.uploadDir, name));
    return `uploads/knowledge/${name}`;
  }

  /** 清理超过保留期的暂存文件（用户中途放弃复核时不留下孤儿文件）。 */
  private pruneTempFiles(): void {
    try {
      if (!existsSync(this.tempDir)) return;
      const deadline = Date.now() - this.tempTtlMs;
      let removed = 0;
      for (const name of readdirSync(this.tempDir)) {
        const path = join(this.tempDir, name);
        const stat = statSync(path);
        if (stat.isFile() && stat.mtimeMs < deadline) {
          rmSync(path, { force: true });
          removed += 1;
        }
      }
      if (removed > 0) this.logger.log(`已清理 ${removed} 个超期暂存文件`);
    } catch (error) {
      this.logger.warn(`清理暂存目录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 取暂存/留档文件名，供下载原文校验。 */
  static safeFileName(fileName: string): string {
    return fileName.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').slice(-80);
  }

  static deriveTitle(title: string | undefined, content: string): string {
    const explicit = title?.trim();
    if (explicit) return explicit.slice(0, 60);
    // OCR 片段的首行往往只有"【扫描页文字（本地 OCR）】"这类来源标记，标题要取第一行有意义的正文。
    const meaningful = content
      .split('\n')
      .map((line) => line.replace(/^[#*\-0-9.、\s]+/, '').replace(/^【[^】]*】/, '').trim())
      .find((line) => line.length >= 4);
    return (meaningful ?? '未命名片段').slice(0, 60);
  }

  /** 导入后批量确认启用（或反向停用）。 */
  async batchActivate(dto: BatchActivateDto, actor: KnowledgeActor): Promise<{ updated: number }> {
    const scope = await this.workspaceContext.current();
    const result = await this.knowledge
      .createQueryBuilder()
      .update(BrandKnowledge)
      .set({ isActive: dto.isActive })
      .where('workspace_id = :workspaceId AND id IN (:...ids)', { workspaceId: scope.workspaceId, ids: dto.ids })
      .execute();
    await this.record('knowledge.batch_activate', dto.ids[0] ?? '', actor, { count: dto.ids.length, isActive: dto.isActive });
    return { updated: result.affected ?? 0 };
  }

  async findByIds(ids: string[]): Promise<BrandKnowledge[]> {
    if (ids.length === 0) return [];
    const scope = await this.workspaceContext.current();
    return this.knowledge.find({ where: { id: In(ids), workspaceId: scope.workspaceId } });
  }

  /** 启动时把数据库里的分类加载进校验码表，DTO 校验才能接受自定义分类。 */
  async onModuleInit(): Promise<void> {
    try {
      const list = await this.categories();
      setCategoryCodes(list.map((item) => item.code));
      this.logger.log(`知识库分类已加载：${list.map((item) => item.label).join('、')}`);
    } catch (error) {
      this.logger.warn(`知识库分类加载失败，使用默认分类：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 当前生效的分类配置（数据库优先，未配置时用默认分类）。 */
  async categories(): Promise<KnowledgeCategoryDef[]> {
    return parseStoredCategories(await this.settings.get(CATEGORY_SETTING_KEY));
  }

  /**
   * 保存整套分类配置。为安全起见：正在被资料使用的分类不允许删除，
   * 必须先把那些资料改到别的分类（或删除），避免出现"孤儿分类"。
   */
  async saveCategories(dto: SaveCategoriesDto, actor: KnowledgeActor): Promise<KnowledgeCategoryDef[]> {
    const scope = await this.workspaceContext.current();
    const next = normalizeCategories(dto.categories);
    const current = await this.categories();
    const nextCodes = new Set(next.map((item) => item.code));
    const removed = current.filter((item) => !nextCodes.has(item.code));

    if (removed.length > 0) {
      const rows = await this.knowledge
        .createQueryBuilder('knowledge')
        .select('knowledge.category', 'category')
        .addSelect('COUNT(*)', 'count')
        .where('knowledge.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
        .groupBy('knowledge.category')
        .getRawMany<{ category: string; count: string }>();
      const usage = new Map(rows.map((row) => [row.category, Number(row.count)]));
      const blocking = removed
        .map((item) => ({ label: item.label, count: usage.get(item.code) ?? 0 }))
        .filter((item) => item.count > 0);
      if (blocking.length > 0) {
        throw new BadRequestException(
          `以下分类还有资料在用，先把它们改到其他分类再删除：${blocking.map((item) => `${item.label}（${item.count} 条）`).join('、')}`,
        );
      }
    }

    await this.settings.updateMany(
      [{ key: CATEGORY_SETTING_KEY, value: JSON.stringify(next) }],
      { id: actor.id ?? null, name: actor.name ?? null },
    );
    setCategoryCodes(next.map((item) => item.code));
    await this.record('knowledge.save_categories', '', actor, { count: next.length, codes: next.map((item) => item.code) });
    this.logger.log(`知识库分类已更新：${next.map((item) => item.label).join('、')}`);
    return next;
  }

  /** 分类使用情况（用于界面上提示每个分类有多少条资料）。 */
  async categoryUsage(): Promise<Record<string, number>> {
    const scope = await this.workspaceContext.current();
    const rows = await this.knowledge
      .createQueryBuilder('knowledge')
      .select('knowledge.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('knowledge.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .groupBy('knowledge.category')
      .getRawMany<{ category: string; count: string }>();
    return Object.fromEntries(rows.map((row) => [row.category, Number(row.count)]));
  }

  /** 检索测试台：喂一段标题/正文，看实际会引用哪几条资料、为什么命中。 */
  async match(dto: MatchKnowledgeDto): Promise<{ matches: KnowledgeMatch[] }> {
    return {
      matches: await this.findRelevant(
        { title: dto.title ?? '', body: dto.body ?? '', tags: dto.tags, platform: dto.platform },
        dto.limit ?? DEFAULT_LIMIT,
      ),
    };
  }

  /**
   * 导出知识库。json 是原生格式（含分类配置，可整站迁移），csv/markdown 用于对外交换。
   */
  async exportEntries(format: ExportFormat, query: { brand?: string; category?: string; includeInactive?: boolean }): Promise<{ fileName: string; mimeType: string; content: string }> {
    const scope = await this.workspaceContext.current();
    const builder = this.knowledge
      .createQueryBuilder('knowledge')
      .where('knowledge.workspaceId = :workspaceId', { workspaceId: scope.workspaceId })
      .orderBy('knowledge.priority', 'DESC')
      .addOrderBy('knowledge.createdAt', 'ASC');
    if (query.brand) builder.andWhere('knowledge.brand = :brand', { brand: query.brand });
    if (query.category) builder.andWhere('knowledge.category = :category', { category: query.category });
    if (!query.includeInactive) builder.andWhere('knowledge.isActive = true');

    const rows = await builder.getMany();
    const entries: TransferEntry[] = rows.map((row) => ({
      brand: row.brand,
      category: row.category,
      title: row.title,
      content: row.content,
      tags: row.tags,
      keywords: row.keywords,
      priority: row.priority,
      isActive: row.isActive,
      aiGenerated: row.aiGenerated,
      platforms: row.platforms,
    }));

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      return { fileName: `知识库导出-${stamp}.csv`, mimeType: 'text/csv;charset=utf-8', content: this.transfer.toCsv(entries) };
    }
    if (format === 'markdown') {
      const categories = await this.categories();
      const labels = new Map(categories.map((item) => [item.code, item.label]));
      return { fileName: `知识库导出-${stamp}.md`, mimeType: 'text/markdown;charset=utf-8', content: this.transfer.toMarkdown(entries, labels) };
    }

    const payload = {
      format: 'mediaflow.knowledge',
      version: 1,
      exportedAt: new Date().toISOString(),
      /** 分类配置一并导出：换一套系统/换一家公司时可以直接带过去。 */
      categories: await this.categories(),
      items: entries,
    };
    return { fileName: `知识库导出-${stamp}.json`, mimeType: 'application/json;charset=utf-8', content: JSON.stringify(payload, null, 2) };
  }

  /** 导入第一步：解析文件 + 自动识别字段映射，不写库。 */
  async previewImport(file: { originalname: string; buffer: Buffer }): Promise<{
    fileName: string;
    format: ParsedTable['format'];
    columns: string[];
    mapping: FieldMapping;
    unmappedTargets: Array<{ target: string; label: string }>;
    preview: Array<Record<string, string>>;
    /** 解析出的全部行（上限 2000），前端确认映射后原样回传给提交接口 */
    rows: Array<Record<string, string>>;
    total: number;
    warnings: string[];
  }> {
    const fileName = KnowledgeService.normalizeFileName(file.originalname);
    const parsed = await this.transfer.parseFile(fileName, file.buffer);
    const mapping = autoMapColumns(parsed.columns);
    return {
      fileName,
      format: parsed.format,
      columns: parsed.columns,
      mapping,
      unmappedTargets: MAPPING_TARGETS.filter((target) => !mapping[target]).map((target) => ({ target, label: TARGET_LABELS[target] })),
      preview: parsed.rows.slice(0, 5),
      rows: parsed.rows.slice(0, 2000),
      total: parsed.rows.length,
      warnings: parsed.rows.length > 2000 ? [...parsed.warnings, '文件行数超过 2000，仅载入前 2000 行'] : parsed.warnings,
    };
  }

  /**
   * 导入第二步：按确认后的映射入库。
   * 默认按"品牌+标题+正文前 200 字"去重，避免同一份文件重复导入把知识库灌两遍。
   */
  async commitImportData(
    dto: {
      rows: Array<Record<string, string>>;
      mapping: FieldMapping;
      brand: string;
      category: string;
      priority?: number;
      isActive?: boolean;
      skipDuplicates?: boolean;
      sourceFileName?: string;
      categories?: unknown;
      applyCategories?: boolean;
    },
    actor: KnowledgeActor,
  ): Promise<{ created: number; skipped: Array<{ row: number; reason: string }>; duplicates: number; categoriesApplied: boolean }> {
    const scope = await this.workspaceContext.current();
    if (dto.rows.length === 0) throw new BadRequestException('没有可导入的数据行');
    if (dto.rows.length > 2000) throw new BadRequestException('单次最多导入 2000 条，请拆分文件后分批导入');

    let categoriesApplied = false;
    if (dto.applyCategories && dto.categories) {
      await this.saveCategories({ categories: dto.categories as never }, actor);
      categoriesApplied = true;
    }

    const { entries, skipped } = this.transfer.buildEntries(dto.rows, dto.mapping, {
      brand: dto.brand,
      category: dto.category,
      priority: dto.priority ?? 0,
      isActive: dto.isActive ?? true,
    });

    if (entries.length === 0) {
      throw new BadRequestException(`没有可入库的内容：${skipped.slice(0, 3).map((item) => `第 ${item.row} 行 ${item.reason}`).join('；')}`);
    }

    const skipDuplicates = dto.skipDuplicates ?? true;
    const existing = skipDuplicates
      ? new Set(
          (
            await this.knowledge.find({ where: { workspaceId: scope.workspaceId }, select: ['brand', 'title', 'content'] })
          ).map((row) => this.transfer.signature(row)),
        )
      : new Set<string>();

    const seen = new Set<string>();
    const toSave: TransferEntry[] = [];
    let duplicates = 0;
    for (const entry of entries) {
      const signature = this.transfer.signature(entry);
      if (existing.has(signature) || seen.has(signature)) {
        duplicates += 1;
        continue;
      }
      seen.add(signature);
      toSave.push(entry);
    }
    if (toSave.length === 0) {
      throw new BadRequestException(`全部 ${duplicates} 条都与现有资料重复，已跳过（如确认要导入，请关闭「跳过重复」）`);
    }

    const tags = dto.sourceFileName ? [`来源：${dto.sourceFileName}`] : [];
    const created = await this.persistEntries(toSave, { tenantId: scope.tenantId, workspaceId: scope.workspaceId, tags });
    await this.record('knowledge.import_data', created[0] ?? '', actor, {
      rows: dto.rows.length,
      created: created.length,
      duplicates,
      skipped: skipped.length,
      sourceFileName: dto.sourceFileName ?? '',
    });
    this.logger.log(`知识库导入完成：新增 ${created.length} 条，重复跳过 ${duplicates} 条，无效 ${skipped.length} 条`);
    return { created: created.length, skipped, duplicates, categoriesApplied };
  }

  /** 批量写入"完整字段"的资料（导入/恢复用，区别于文档切片）。 */
  private async persistEntries(
    entries: TransferEntry[],
    scope: { tenantId: string; workspaceId: string; tags: string[] },
  ): Promise<string[]> {
    const created: string[] = [];
    for (const entry of entries) {
      const saved = await this.knowledge.save(
        this.knowledge.create({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          brand: entry.brand,
          category: entry.category,
          title: entry.title.slice(0, 200),
          content: entry.content,
          tags: [...new Set([...(entry.tags ?? []), ...scope.tags])].slice(0, 20),
          keywords: (entry.keywords ?? []).slice(0, 20),
          priority: entry.priority,
          platforms: entry.platforms ?? [],
          sourceUrl: '',
          isActive: entry.isActive,
          usageCount: 0,
          lastUsedAt: null,
          aiGenerated: entry.aiGenerated ?? false,
        }),
      );
      created.push(saved.id);
    }
    return created;
  }

  /**
   * AI 起草一条品牌资料。只返回草案，人工确认后再走 create() 入库。
   * 会把同品牌已有资料一起喂给模型，避免新条目和现有口径打架。
   */
  async aiDraft(dto: AiGenerateKnowledgeDto, actor: KnowledgeActor): Promise<{ draft: KnowledgeDraft; generationId: string; model: string; references: string[] }> {
    const scope = await this.workspaceContext.current();
    const references = await this.knowledge.find({
      where: { workspaceId: scope.workspaceId, brand: dto.brand, isActive: true },
      order: { priority: 'DESC', updatedAt: 'DESC' },
      take: 3,
    });

    const result = await this.ai.generateKnowledge(
      {
        brand: dto.brand,
        category: dto.category,
        points: dto.points,
        platform: dto.platform,
        tone: dto.tone,
        references: references.map((item) => ({ title: item.title, content: item.content })),
      },
      { inputRefs: { brand: dto.brand, category: dto.category, knowledgeIds: references.map((item) => item.id) }, requestedBy: actor.id ?? null },
    );

    await this.record('knowledge.ai_draft', '', actor, { brand: dto.brand, category: dto.category, generationId: result.generationId });
    return { ...result, references: references.map((item) => item.title) };
  }

  /** AI 润色（可作用于还没保存的草稿）：只改表达与合规，不动事实。 */
  async aiPolish(dto: AiPolishKnowledgeDto, actor: KnowledgeActor): Promise<{ content: string; generationId: string }> {
    const result = await this.ai.polishKnowledge(
      { brand: dto.brand ?? '', category: dto.category ?? '', content: dto.content, instruction: dto.instruction },
      { requestedBy: actor.id ?? null },
    );
    await this.record('knowledge.ai_polish', '', actor, { generationId: result.generationId, brand: dto.brand ?? '' });
    return result;
  }

  /** 按来源文件分组，便于整批启用/停用/删除某次导入的资料。 */
  async sources(): Promise<KnowledgeSourceGroup[]> {
    const scope = await this.workspaceContext.current();
    const rows = await this.knowledge.find({
      where: { workspaceId: scope.workspaceId },
      order: { createdAt: 'ASC' },
    });

    const groups = new Map<string, KnowledgeSourceGroup>();
    for (const row of rows) {
      if (!row.sourceUrl) continue;
      const group = groups.get(row.sourceUrl) ?? {
        sourceUrl: row.sourceUrl,
        fileName: sourceFileName(row.sourceUrl),
        count: 0,
        activeCount: 0,
        lastCreatedAt: row.createdAt.toISOString(),
        ids: [],
      };
      group.count += 1;
      if (row.isActive) group.activeCount += 1;
      group.lastCreatedAt = row.createdAt.toISOString();
      group.ids.push(row.id);
      groups.set(row.sourceUrl, group);
    }
    return [...groups.values()].sort((left, right) => right.lastCreatedAt.localeCompare(left.lastCreatedAt));
  }

  /**
   * 知识库体检：重复条目 + 明显欠打磨的条目。
   * 说明：重复检测用「归一化后的 3-gram Jaccard 相似度」，中文不做分词，阈值 0.75 以压低误报。
   */
  async auditReport(): Promise<KnowledgeAuditReport> {
    const scope = await this.workspaceContext.current();
    const rows = await this.knowledge.find({
      where: { workspaceId: scope.workspaceId },
      order: { createdAt: 'DESC' },
      take: 300,
    });
    const active = rows.filter((row) => row.isActive);
    const issues: KnowledgeAuditIssue[] = [];

    for (const row of active) {
      const length = row.content.replace(/\s/g, '').length;
      if (length < 60) {
        issues.push({ id: row.id, title: row.title, brand: row.brand, kind: 'too_short', detail: `正文只有 ${length} 字，信息量太少，建议补充或合并` });
      } else if (length > 2000) {
        issues.push({ id: row.id, title: row.title, brand: row.brand, kind: 'too_long', detail: `正文 ${length} 字，偏长，建议拆成多条` });
      }
      if (row.tags.length === 0 && row.keywords.length === 0) {
        issues.push({ id: row.id, title: row.title, brand: row.brand, kind: 'no_tags', detail: '没有标签也没有关键词，检索时很难被命中' });
      }
      const ageDays = (Date.now() - new Date(row.createdAt).getTime()) / 86_400_000;
      if (row.usageCount === 0 && ageDays > 30) {
        issues.push({ id: row.id, title: row.title, brand: row.brand, kind: 'never_used', detail: `入库 ${Math.floor(ageDays)} 天从未被引用，考虑停用或改写` });
      }
    }

    const duplicateGroups: KnowledgeAuditReport['duplicateGroups'] = [];
    const grams = new Map<string, Set<string>>();
    for (const row of active) grams.set(row.id, KnowledgeService.grams(row.content));
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const similarity = KnowledgeService.jaccard(grams.get(active[i].id)!, grams.get(active[j].id)!);
        if (similarity >= 0.75) {
          duplicateGroups.push({
            similarity: Number(similarity.toFixed(2)),
            items: [
              { id: active[i].id, title: active[i].title, brand: active[i].brand },
              { id: active[j].id, title: active[j].title, brand: active[j].brand },
            ],
          });
        }
      }
    }

    return {
      summary: {
        total: rows.length,
        active: active.length,
        inactive: rows.length - active.length,
        neverUsed: active.filter((row) => row.usageCount === 0).length,
        aiGenerated: rows.filter((row) => row.aiGenerated).length,
        duplicateGroups: duplicateGroups.length,
        checkedAt: new Date().toISOString(),
      },
      duplicateGroups: duplicateGroups.slice(0, 20),
      issues: issues.slice(0, 100),
    };
  }

  /** 批量软删除（用于「按来源整批清理」）。 */
  async batchRemove(dto: BatchDeleteKnowledgeDto, actor: KnowledgeActor): Promise<{ removed: number }> {
    const scope = await this.workspaceContext.current();
    const result = await this.knowledge
      .createQueryBuilder()
      .softDelete()
      .where('workspace_id = :workspaceId AND id IN (:...ids)', { workspaceId: scope.workspaceId, ids: dto.ids })
      .execute();
    await this.record('knowledge.batch_delete', dto.ids[0] ?? '', actor, { count: dto.ids.length });
    return { removed: result.affected ?? 0 };
  }

  /** 归一化文本的 3-gram 集合（去空白与标点）。 */
  private static grams(text: string): Set<string> {
    const normalized = text.replace(/[\s，。、；：！？,.;:!?"'（）()【】\[\]-]/g, '');
    const grams = new Set<string>();
    for (let index = 0; index + 3 <= normalized.length; index += 1) grams.add(normalized.slice(index, index + 3));
    return grams;
  }

  private static jaccard(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) return 0;
    let shared = 0;
    for (const gram of left) if (right.has(gram)) shared += 1;
    return shared / (left.size + right.size - shared);
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
