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
  manager: { softDelete: ReturnType<typeof vi.fn>; createQueryBuilder: ReturnType<typeof vi.fn> };
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

  const cascadeQuery = { update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn(async () => ({ affected: 2 })) };
  const manager = {
    softDelete: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(() => cascadeQuery),
  };
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
  it('records the chosen AI flag but does NOT append any disclosure to the body', async () => {
    const { service, contents } = buildService();

    const created = await service.create(
      { title: '标题', body: '正文', aiFlagType: AiFlagType.Assisted },
      { name: 'tester' },
    );

    expect(contents.save).toHaveBeenCalledTimes(1);
    // 标识按填写值记录（便于统计与追溯）……
    expect(created.aiGenerated).toBe(true);
    expect(created.aiFlagChecked).toBe(false);
    // ……但正文一个字都不改：系统不再自动追加「（本文由 AI 辅助生成）」
    expect(created.body).toBe('正文');
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
    // 同一事务里还要把未完成的发布任务取消掉（否则队列里会留下"幽灵任务"）
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
  });
});

describe('ContentService aiAdapt', () => {
  it('persists a variant per platform without touching the body', async () => {
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
    // 平台版本同样不再自动追加标识文案（正文只来自 AI 返回内容本身）
    expect(saved.body).not.toContain('本文由 AI 辅助生成');
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


describe('内容状态机：状态只能由审批流/归档推进（任务 3 / 审计 P1-1）', () => {
  const actor = { id: 'u-1', name: '运营' };

  it('创建永远落 draft，即使调用方塞了 status', async () => {
    const { service, contents } = buildService();
    await service.create({ title: '标题', body: '正文内容足够长。' , status: 'approved' } as never, actor);

    const created = (contents.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { status: string };
    expect(created.status).toBe('draft');
  });

  it('更新不会改变状态（dto 里的 status 被忽略）', async () => {
    const existing = { id: 'c-1', title: '标题', body: '正文', status: 'draft', tags: [], mediaUrls: [] } as unknown as Content;
    const contents = repositoryMock<Content>({ findOne: vi.fn(async () => existing) });
    const variants = repositoryMock<ContentVariant>({ find: vi.fn(async () => []) });
    const revisionsRepo = repositoryMock<ContentRevision>({ findOne: vi.fn(async () => null), find: vi.fn(async () => []) });
    const ai = { adapt: vi.fn() } as unknown as AiService;
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const workspaceContext = { current: vi.fn(async () => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID })) } as unknown as WorkspaceContextService;
    const dataSource = { createQueryBuilder: vi.fn(() => ({ update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn(async () => undefined) })) };
    const knowledge = { findRelevant: vi.fn(async () => []), markUsed: vi.fn() };
    const service = new ContentService(contents, variants, revisionsRepo, ai, knowledge as never, audit, workspaceContext, dataSource as never);

    const saved = await service.update('c-1', { title: '标题', body: '正文', status: 'approved' } as never, actor);

    expect(saved.status).toBe('draft');
  });

  it('归档写入 content.status_change（from/to/reason）', async () => {
    const existing = { id: 'c-1', title: '标题', body: '正文', status: 'draft', tags: [], mediaUrls: [] } as unknown as Content;
    const contents = repositoryMock<Content>({ findOne: vi.fn(async () => existing), update: vi.fn(async () => ({ affected: 1 })) });
    const variants = repositoryMock<ContentVariant>({ find: vi.fn(async () => []) });
    const revisionsRepo = repositoryMock<ContentRevision>({ findOne: vi.fn(async () => null), find: vi.fn(async () => []) });
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const workspaceContext = { current: vi.fn(async () => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID })) } as unknown as WorkspaceContextService;
    const dataSource = { createQueryBuilder: vi.fn(() => ({ update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn(async () => undefined) })) };
    const service = new ContentService(contents, variants, revisionsRepo, { adapt: vi.fn() } as unknown as AiService, { findRelevant: vi.fn(async () => []) } as never, audit, workspaceContext, dataSource as never);

    await service.archive('c-1', true, actor);

    const actions = (audit.record as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions).toContain('content.archive');
    expect(actions).toContain('content.status_change');
    const change = (audit.record as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { action: string; payload: Record<string, unknown> })
      .find((entry) => entry.action === 'content.status_change');
    expect(change?.payload).toMatchObject({ from: 'draft', to: 'archived', reason: '归档' });
  });
});

describe('DTO 白名单：status 不可由客户端提交', () => {
  it('CreateContentDto 在 whitelist 校验后不含 status', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { CreateContentDto } = await import('../dto/content.dto');

    const dto = plainToInstance(CreateContentDto, { title: '标题', body: '正文', status: 'approved' });
    await validate(dto, { whitelist: true });

    expect('status' in dto).toBe(false);
  });

  it('UpdateContentDto 同样不含 status', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { UpdateContentDto } = await import('../dto/content.dto');

    const dto = plainToInstance(UpdateContentDto, { title: '标题', status: 'approved' });
    await validate(dto, { whitelist: true });

    expect('status' in dto).toBe(false);
  });
});
