import { NotFoundException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../audit/audit.service';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { PlatformCode } from '@mediaflow/shared';
import { BrandKnowledge } from '../entities/brand-knowledge.entity';
import { Content } from '../entities/content.entity';
import { KnowledgeService } from '../knowledge.service';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function repo<T extends ObjectLiteral>(overrides: Partial<Record<string, unknown>> = {}): Repository<T> {
  return {
    findOne: vi.fn(async () => null),
    find: vi.fn(async () => []),
    save: vi.fn(async (value: unknown) => ({ ...(value as object), id: 'saved-id' })),
    create: vi.fn((value: unknown) => value),
    softDelete: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(),
    ...overrides,
  } as unknown as Repository<T>;
}

function item(overrides: Partial<BrandKnowledge> = {}): BrandKnowledge {
  return {
    id: overrides.id ?? 'k1',
    brand: '卿尔美',
    category: 'product',
    title: '畅享版卖点',
    content: '菊粉 + 低聚果糖 + 水苏糖复配，出厂活菌 >200 亿 CFU/盒',
    tags: ['益生菌', '肠道'],
    keywords: ['畅享版', '水苏糖'],
    priority: 0,
    platforms: [],
    usageCount: 0,
    isActive: true,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  } as unknown as BrandKnowledge;
}

function buildService(pool: BrandKnowledge[], content: Partial<Content> | null = null) {
  const knowledge = repo<BrandKnowledge>({ find: vi.fn(async () => pool) });
  const contents = repo<Content>({ findOne: vi.fn(async () => content as Content | null) });
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;
  const parser = {
    parse: vi.fn(async (fileName: string, buffer: Buffer) => ({
      fileName,
      fileType: '.txt',
      text: buffer.toString('utf8'),
      charCount: buffer.length,
      warnings: [],
    })),
    chunk: vi.fn((text: string) => [{ index: 1, title: '片段标题', content: text, charCount: text.length }]),
  } as unknown as import('../document-parser.service').DocumentParserService;
  return { service: new KnowledgeService(knowledge, contents, audit, workspaceContext, parser), knowledge, contents, audit, parser };
}

describe('KnowledgeService 检索', () => {
  it('按标签/关键词命中并按得分排序', async () => {
    const { service } = buildService([
      item({ id: 'k1', title: '命中标签', tags: ['肠道'] }),
      item({ id: 'k2', title: '命中关键词', keywords: ['水苏糖'], tags: [] }),
      item({ id: 'k3', title: '无关资料', tags: ['护肤'], keywords: [], priority: 0 }),
    ]);

    const matches = await service.findRelevant({ title: '秋季肠道健康指南', body: '水苏糖的作用', tags: ['肠道'] });

    expect(matches.map((match) => match.id)).toContain('k1');
    expect(matches.map((match) => match.id)).toContain('k2');
    expect(matches.map((match) => match.id)).not.toContain('k3');
    expect(matches[0].matchedBy.length).toBeGreaterThan(0);
  });

  it('高优先级资料即使没命中关键词也会被带上', async () => {
    const { service } = buildService([item({ id: 'k9', title: '品牌总纲', tags: [], keywords: [], priority: 9 })]);
    const matches = await service.findRelevant({ title: '完全无关的标题', body: '正文' });
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toEqual(['高优先级通用资料']);
  });

  it('限定平台的资料不会串到其他平台', async () => {
    const { service } = buildService([item({ id: 'k1', tags: ['肠道'], platforms: [PlatformCode.Douyin] })]);
    expect(await service.findRelevant({ title: '肠道', platform: PlatformCode.WechatMp })).toHaveLength(0);
    expect(await service.findRelevant({ title: '肠道', platform: PlatformCode.Douyin })).toHaveLength(1);
  });

  it('拼接 prompt 段落包含品牌与标题', async () => {
    const { service } = buildService([]);
    const section = service.buildPromptSection([
      { id: 'k1', brand: '卿尔美', category: 'product', title: '畅享版卖点', content: '复配益生元', matchedBy: [], score: 1 },
    ]);
    expect(section).toContain('卿尔美');
    expect(section).toContain('复配益生元');
    expect(section).toContain('不得编造');
  });

  it('预览某个内容会引用哪些资料', async () => {
    const { service } = buildService([item({ id: 'k1', tags: ['肠道'] })], {
      id: 'c1',
      title: '肠道健康',
      body: '正文',
      tags: ['肠道'],
    });
    const preview = await service.previewForContent('c1');
    expect(preview.matches).toHaveLength(1);
  });

  it('内容不存在时预览报 404', async () => {
    const { service } = buildService([], null);
    await expect(service.previewForContent('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('引用记账：无 id 时不触发更新', async () => {
    const { service, knowledge } = buildService([]);
    await service.markUsed([]);
    expect(knowledge.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('KnowledgeService 文件名解码', () => {
  it('把 latin1 误读的中文文件名还原成 UTF-8', () => {
    const mangled = Buffer.from('公司简介.pdf', 'utf8').toString('latin1');
    expect(KnowledgeService.normalizeFileName(mangled)).toBe('公司简介.pdf');
  });

  it('纯英文文件名保持不变', () => {
    expect(KnowledgeService.normalizeFileName('company-profile.pdf')).toBe('company-profile.pdf');
  });

  it('导入时使用还原后的文件名作为来源标签', async () => {
    const { service } = buildService([]);
    const mangled = Buffer.from('产品卖点.docx', 'utf8').toString('latin1');
    const result = await service.importDocument(
      { originalname: mangled, buffer: Buffer.from('卿尔美畅享版复配益生元相关内容内容'), size: 40 },
      { brand: '卿尔美', category: 'product' },
      { id: 'u1' },
    );
    expect(result.parsed.fileName).toBe('产品卖点.docx');
    expect(result.storedPath).toContain('产品卖点');
  });
});

describe('KnowledgeService 文档导入', () => {
  it('导入生成停用草稿（默认不直接启用）', async () => {
    const { service, knowledge } = buildService([]);
    const result = await service.importDocument(
      { originalname: '公司简介.txt', buffer: Buffer.from('卿尔美成立于某年，专注膳食纤维与益生元。'), size: 40 },
      { brand: '卿尔美', category: 'brand', autoActivate: false },
      { id: 'u1', name: '编辑' },
    );

    expect(result.created).toHaveLength(1);
    expect(result.created[0].isActive).toBe(false);
    expect(result.storedPath).toContain('uploads/knowledge/');
    expect(knowledge.save).toHaveBeenCalledWith(
      expect.objectContaining({ tags: expect.arrayContaining(['来源：公司简介.txt']), isActive: false }),
    );
  });

  it('autoActivate 为 true 时直接启用', async () => {
    const { service } = buildService([]);
    const result = await service.importDocument(
      { originalname: '简介.md', buffer: Buffer.from('内容内容内容内容内容内容'), size: 24 },
      { brand: '卿尔美', category: 'brand', autoActivate: true },
      { id: 'u1' },
    );
    expect(result.created[0].isActive).toBe(true);
  });

  it('批量启用/停用', async () => {
    const { service, knowledge } = buildService([]);
    const queryBuilder = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn(async () => ({ affected: 3 })),
    };
    (knowledge.createQueryBuilder as unknown as ReturnType<typeof vi.fn>).mockReturnValue(queryBuilder);

    const result = await service.batchActivate({ ids: ['a', 'b', 'c'], isActive: true }, { id: 'u1' });

    expect(result.updated).toBe(3);
    expect(queryBuilder.set).toHaveBeenCalledWith({ isActive: true });
  });
});

describe('KnowledgeService 增删改', () => {
  it('创建时默认启用且引用次数为 0', async () => {
    const { service } = buildService([]);
    const saved = await service.create(
      { brand: '金善加', category: 'product', title: 'C 版卖点', content: '30 种维生素矿物质' },
      { id: 'u1', name: '编辑' },
    );
    expect(saved.isActive).toBe(true);
    expect(saved.usageCount).toBe(0);
  });

  it('不存在的资料更新时报 404', async () => {
    const { service } = buildService([]);
    await expect(
      service.update('missing', { brand: 'x', category: 'brand', title: 't', content: 'c' }, { id: 'u1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
