import { ConflictException } from '@nestjs/common';
import { AiFlagType, ContentStatus, PlatformCode } from '@mediaflow/shared';
import { ObjectLiteral, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../audit/audit.service';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { AiService } from '../../ai/ai.service';
import { ContentRevision } from '../entities/content-revision.entity';
import { ContentVariant } from '../entities/content-variant.entity';
import { Content } from '../entities/content.entity';
import { ContentService } from '../content.service';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function repositoryMock<T extends ObjectLiteral>(overrides: Partial<Record<string, unknown>> = {}): Repository<T> {
  return {
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: unknown) => ({ ...(value as object), id: 'saved-id' })),
    findOne: vi.fn(),
    find: vi.fn(async () => []),
    softDelete: vi.fn(async () => ({ affected: 1 })),
    ...overrides,
  } as unknown as Repository<T>;
}

interface ContentServiceHarness {
  service: ContentService;
  contents: Repository<Content>;
  variants: Repository<ContentVariant>;
  ai: AiService;
  manager: { softDelete: ReturnType<typeof vi.fn> };
  knowledge: { findRelevant: ReturnType<typeof vi.fn>; markUsed: ReturnType<typeof vi.fn> };
}

const revisions = {
  findOne: vi.fn(async () => null),
  find: vi.fn(async () => []),
  save: vi.fn(async (value: unknown) => value),
  create: vi.fn((value: unknown) => value),
  remove: vi.fn(async () => undefined),
} as unknown as Repository<ContentRevision>;

function buildService(options: { existingVariants?: Partial<ContentVariant>[] } = {}): ContentServiceHarness {
  const contents = repositoryMock<Content>();
  const variants = repositoryMock<ContentVariant>({
    findOne: vi.fn(async () => null),
    find: vi.fn(async () => (options.existingVariants ?? []) as ContentVariant[]),
  });
  const ai = {
    adapt: vi.fn(async () => ({
      generationId: 'gen-1',
      model: 'mock-model',
      variants: [{ platform: PlatformCode.WechatMp, title: 'AI 标题', body: 'AI 正文', tags: ['健康'] }],
    })),
  } as unknown as AiService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;

  const manager = { softDelete: vi.fn(async () => ({ affected: 1 })) };
  const knowledge = {
    findRelevant: vi.fn(async () => []),
    buildPromptSection: vi.fn(() => ''),
    markUsed: vi.fn(async () => undefined),
  };
  const dataSource = {
    transaction: async (work: (m: typeof manager) => Promise<unknown>) => work(manager),
  } as unknown as import('typeorm').DataSource;
  return {
    service: new ContentService(contents, variants, revisions, ai, knowledge as never, audit, workspaceContext, dataSource),
    contents,
    variants,
    ai,
    manager,
    knowledge,
  };
}

describe('ContentService disclosure', () => {
  it('marks AI assisted content and appends the disclosure to the stored body', async () => {
    const { service, contents } = buildService();

    const created = await service.create(
      { title: '标题', body: '正文', aiFlagType: AiFlagType.Assisted },
      { name: 'tester' },
    );

    expect(contents.save).toHaveBeenCalledTimes(1);
    expect(created.aiGenerated).toBe(true);
    expect(created.aiFlagChecked).toBe(false);
    expect(created.body.endsWith('（本文由 AI 辅助生成）')).toBe(true);
  });

  it('does not touch human written bodies', async () => {
    const { service } = buildService();
    const created = await service.create({ title: '标题', body: '人工正文' }, { name: 'tester' });

    expect(created.aiGenerated).toBe(false);
    expect(created.body).toBe('人工正文');
  });

  it('已通过审核的内容被再次编辑时退回草稿（审核结论失效）', async () => {
    const { service, contents } = buildService();
    (contents.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c9',
      title: '原标题',
      body: '原正文',
      tags: [],
      mediaUrls: [],
      status: ContentStatus.Approved,
      aiFlagType: AiFlagType.None,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
    } as unknown as Content);

    const saved = await service.update('c9', { body: '改过的正文' }, { name: 'tester' });

    expect(saved.status).toBe(ContentStatus.Draft);
  });

  it('soft deletes instead of removing the row', async () => {
    const content = { id: 'c1', title: '标题', tenantId: TENANT_ID, workspaceId: WORKSPACE_ID } as Content;
    const { service, manager } = buildService();
    (service as unknown as { contents: { findOne: unknown } }).contents;
    const contentsRepo = (service as unknown as { contents: { findOne: ReturnType<typeof vi.fn> } }).contents;
    contentsRepo.findOne.mockResolvedValue(content);

    const result = await service.remove('c1', { name: 'tester' });

    expect(result.id).toBe('c1');
    // 内容与其平台版本在同一个事务中软删
    expect(manager.softDelete).toHaveBeenCalledWith(expect.anything(), { id: 'c1' });
    expect(manager.softDelete).toHaveBeenCalledWith(expect.anything(), { contentId: 'c1' });
  });
});

describe('ContentService aiAdapt', () => {
  it('persists a variant per platform with the disclosure applied', async () => {
    const content = {
      id: 'c1',
      title: '标题',
      body: '正文',
      tags: ['健康'],
      mediaUrls: [],
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      aiFlagType: AiFlagType.None,
      status: ContentStatus.Draft,
      variants: [],
    } as unknown as Content;
    const { service, contents, variants } = buildService();
    (contents.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(content);

    const result = await service.aiAdapt(
      'c1',
      { platforms: [PlatformCode.WechatMp] },
      { name: 'tester' },
    );

    expect(result.variants).toHaveLength(1);
    expect(variants.save).toHaveBeenCalledTimes(1);
    const saved = result.variants[0];
    expect(saved.aiFlagType).toBe(AiFlagType.Assisted);
    expect(saved.generationId).toBe('gen-1');
    expect(saved.body.endsWith('（本文由 AI 辅助生成）')).toBe(true);
  });

  it('rejects early when every requested platform already exists', async () => {
    const content = {
      id: 'c1',
      title: '标题',
      body: '正文',
      tags: [],
      mediaUrls: [],
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      aiFlagType: AiFlagType.None,
      variants: [],
    } as unknown as Content;
    const { service, contents, ai } = buildService({
      existingVariants: [{ platform: PlatformCode.WechatMp }],
    });
    (contents.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(content);

    await expect(
      service.aiAdapt('c1', { platforms: [PlatformCode.WechatMp] }, { name: 'tester' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((ai.adapt as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
