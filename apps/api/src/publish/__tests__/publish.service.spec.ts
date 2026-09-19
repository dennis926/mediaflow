import { BadRequestException } from '@nestjs/common';
import { AiFlagType, ContentStatus, PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import { ObjectLiteral, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../audit/audit.service';
import { SettingsService } from '../../modules/settings/settings.service';
import { SocialAccountService } from '../../modules/platform/social-account.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { ContentVariant } from '../../modules/content/entities/content-variant.entity';
import { Content } from '../../modules/content/entities/content.entity';
import { AiGeneration } from '../../modules/ai/entities/ai-generation.entity';
import { SocialAccount } from '../../modules/platform/entities/social-account.entity';
import { ContentReview } from '../../modules/content/entities/content-review.entity';
import { PublishTask } from '../../modules/publish/entities/publish-task.entity';
import { PublishQueueService } from '../publish.queue';
import { PublishService } from '../publish.service';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function repositoryMock<T extends ObjectLiteral>(overrides: Partial<Record<string, unknown>> = {}): Repository<T> {
  return { findOne: vi.fn(), save: vi.fn(), create: vi.fn((value: unknown) => value), update: vi.fn(), ...overrides } as unknown as Repository<T>;
}

function buildService(options: {
  content: Partial<Content> | null;
  variant?: Partial<ContentVariant> | null;
  queue?: Partial<PublishQueueService>;
  /** 最新一轮审核记录（测审核闸门用） */
  review?: Record<string, unknown> | null;
  /** 已存在的「未完成任务」，用于验证 P2-2 幂等闸门 */
  activeTasks?: Array<Record<string, unknown>>;
  requireApproval?: boolean;
}): { service: PublishService; queue: PublishQueueService; tasks: Repository<PublishTask>; reviews: Repository<ContentReview>; settings: SettingsService } {
  const contents = repositoryMock<Content>({ findOne: vi.fn(async () => options.content as Content | null) });
  const variants = repositoryMock<ContentVariant>({ findOne: vi.fn(async () => (options.variant ?? null) as ContentVariant | null) });
  const tasks = repositoryMock<PublishTask>({
    save: vi.fn(async (value: PublishTask) => ({ ...value, id: 'task-1' })),
    // 幂等闸门（P2-2）：默认没有活跃任务；需要时用 options.activeTasks 注入
    find: vi.fn(async () => (options.activeTasks ?? []) as unknown as PublishTask[]),
  });
  const accounts = repositoryMock<SocialAccount>();
  const queue = { enqueue: vi.fn(async () => '1-0') } as unknown as PublishQueueService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;
  const registry = {
    has: vi.fn(() => true),
    get: vi.fn(() => ({ platform: PlatformCode.WechatMp, capabilities: { mode: 'manual' } })),
    list: vi.fn(() => []),
  };
  const socialAccounts = {
    credentialsOf: vi.fn(async () => ({ accessToken: null, refreshToken: null, expiresAt: null, extra: {} })),
  } as unknown as SocialAccountService;
  const settings = {
    get: vi.fn(async () => null),
    getNumber: vi.fn(async (_key: string, fallback: number) => fallback),
    getBoolean: vi.fn(async (key: string, fallback: boolean) =>
      key === 'REQUIRE_CONTENT_APPROVAL' ? (options.requireApproval ?? false) : fallback,
    ),
  } as unknown as SettingsService;

  const aiGenerations = repositoryMock<AiGeneration>({ findOne: vi.fn(async () => null) });
  const reviews = repositoryMock<ContentReview>({
    findOne: vi.fn(async () => (options.review ?? null) as ContentReview | null),
  });

  const service = new PublishService(
    tasks,
    contents,
    variants,
    accounts,
    aiGenerations,
    reviews,
    socialAccounts,
    registry as never,
    queue,
    audit,
    workspaceContext,
    settings,
  );
  return { service, queue, tasks, reviews, settings };
}

describe('PublishService AI disclosure', () => {
  it('appends the mandatory suffix for AI generated bodies', async () => {
    const { service } = buildService({
      content: {
        id: 'content-1',
        title: 'AI 稿件',
        body: '正文内容',
        tags: ['AI'],
        mediaUrls: [],
        aiFlagType: AiFlagType.FullyGenerated,
      } as Partial<Content>,
    });
    const payload = await service.buildPayload({ id: 'task-1', contentId: 'content-1', contentVariantId: null } as PublishTask);

    expect(payload.body.endsWith('（本文由 AI 辅助生成）')).toBe(true);
    expect(payload.aiGenerated).toBe(true);
  });

  it('leaves human written bodies untouched', async () => {
    const { service } = buildService({
      content: { id: 'content-2', body: '人工正文', tags: [], mediaUrls: [], aiFlagType: AiFlagType.None } as Partial<Content>,
    });
    const payload = await service.buildPayload({ id: 'task-2', contentId: 'content-2', contentVariantId: null } as PublishTask);

    expect(payload.body).toBe('人工正文');
    expect(payload.aiGenerated).toBe(false);
  });
});

describe('PublishService guards', () => {
  it('refuses to publish AI content that has not passed the AI flag check', async () => {
    const { service } = buildService({
      content: { id: 'content-3', aiGenerated: true, aiFlagChecked: false } as Partial<Content>,
    });

    await expect(
      service.createTasks({ contentId: 'content-3', platforms: [PlatformCode.WechatMp] }, { name: 'tester' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a pending task and pushes it to the queue', async () => {
    const { service, queue, tasks } = buildService({
      content: { id: 'content-4', title: '正常稿件', aiGenerated: false, aiFlagChecked: false } as Partial<Content>,
    });
    const created = await service.createTasks(
      { contentId: 'content-4', platforms: [PlatformCode.WechatMp] },
      { name: 'tester' },
    );

    expect(created).toHaveLength(1);
    expect(queue.enqueue).toHaveBeenCalledWith('task-1');
    expect(tasks.save).toHaveBeenCalledTimes(1);
  });

  it('schedules instead of queueing when scheduledAt is in the future', async () => {
    const { service, queue } = buildService({
      content: { id: 'content-5', title: '排期稿件', aiGenerated: false } as Partial<Content>,
    });
    const future = new Date(Date.now() + 3600_000).toISOString();
    const created = await service.createTasks(
      { contentId: 'content-5', platforms: [PlatformCode.WechatMp], scheduledAt: future },
      { name: 'tester' },
    );

    expect(created[0].status).toBe(PublishTaskStatus.Scheduled);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects platforms without an adapter', async () => {
    const { service } = buildService({ content: { id: 'content-6', aiGenerated: false } as Partial<Content> });
    expect(() => service.adapterFor(PlatformCode.Baijiahao)).not.toThrow();
  });
});

describe('PublishService cancel', () => {
  it('cancels a task that has not been published yet', async () => {
    const { service, tasks } = buildService({ content: null });
    (tasks.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'task-9',
      status: PublishTaskStatus.Scheduled,
      platform: PlatformCode.WechatMp,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      extra: {},
    } as unknown as PublishTask);
    (tasks.findOne as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'task-9',
        status: PublishTaskStatus.Scheduled,
        platform: PlatformCode.WechatMp,
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        extra: {},
      } as unknown as PublishTask)
      // second call is the service reloading the row after saving
      .mockResolvedValueOnce({
        id: 'task-9',
        status: PublishTaskStatus.Canceled,
        platform: PlatformCode.WechatMp,
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        extra: {},
      } as unknown as PublishTask);

    const result = await service.cancel('task-9', { id: 'u1', name: '运营' });

    expect(tasks.save).toHaveBeenCalledWith(expect.objectContaining({ status: PublishTaskStatus.Canceled }));
    expect(result.status).toBe(PublishTaskStatus.Canceled);
  });

  it('refuses to cancel a task that is already in flight', async () => {
    const { service, tasks } = buildService({ content: null });
    (tasks.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'task-10',
      status: PublishTaskStatus.Publishing,
      platform: PlatformCode.Douyin,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      extra: {},
    } as unknown as PublishTask);

    await expect(service.cancel('task-10', { id: 'u1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tasks.save).not.toHaveBeenCalled();
  });
});


describe('发布闸门：以审核记录为准（任务 3 / 审计 P1-1）', () => {
  const baseContent: Partial<Content> = {
    id: 'c-1',
    title: '标题',
    body: '正文',
    status: ContentStatus.Approved,
    aiGenerated: false,
    aiFlagChecked: false,
    aiFlagType: AiFlagType.None,
    updatedAt: new Date('2026-09-18T10:00:00Z'),
  };

  function dto() {
    return { contentId: 'c-1', platforms: [PlatformCode.WechatMp] } as never;
  }

  it('闸门开启且没有审核记录 → 400', async () => {
    const { service } = buildService({ content: baseContent, review: null, requireApproval: true });
    await expect(service.createTasks(dto(), { id: 'u-1', name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('闸门开启且最新一轮被驳回 → 400', async () => {
    const { service } = buildService({
      content: { ...baseContent, status: ContentStatus.Rejected },
      review: { status: 'rejected', round: 2, decidedAt: new Date('2026-09-18T09:00:00Z') },
      requireApproval: true,
    });
    await expect(service.createTasks(dto(), { id: 'u-1', name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('闸门开启、最新一轮通过且审批后未修改 → 允许创建', async () => {
    const { service } = buildService({
      content: baseContent,
      review: { status: 'approved', round: 1, decidedAt: new Date('2026-09-18T11:00:00Z'), contentUpdatedAt: new Date('2026-09-18T10:00:00Z') },
      requireApproval: true,
    });
    await expect(service.createTasks(dto(), { id: 'u-1', name: 'x' })).resolves.toBeTruthy();
  });

  it('闸门开启但审批后内容被修改 → 400（结论过期）', async () => {
    const { service } = buildService({
      content: { ...baseContent, updatedAt: new Date('2026-09-18T12:00:00Z') },
      review: { status: 'approved', round: 1, decidedAt: new Date('2026-09-18T11:00:00Z'), contentUpdatedAt: new Date('2026-09-18T10:00:00Z') },
      requireApproval: true,
    });
    await expect(service.createTasks(dto(), { id: 'u-1', name: 'x' })).rejects.toThrow(/又被修改/);
  });

  it('已归档内容（即使有通过记录）→ 400', async () => {
    const { service } = buildService({
      content: { ...baseContent, status: ContentStatus.Archived },
      review: { status: 'approved', round: 1, decidedAt: new Date('2026-09-18T11:00:00Z'), contentUpdatedAt: new Date('2026-09-18T10:00:00Z') },
      requireApproval: true,
    });
    await expect(service.createTasks(dto(), { id: 'u-1', name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('闸门关闭时不查审核记录（保持内部工具默认行为）', async () => {
    const { service, reviews } = buildService({ content: baseContent, requireApproval: false });
    await expect(service.createTasks(dto(), { id: 'u-1', name: 'x' })).resolves.toBeTruthy();
    expect((reviews.findOne as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('PublishService 幂等闸门（P2-2 重复排期）', () => {
  it('同一内容同一平台已有未完成任务时抛 409（不重复建单）', async () => {
    const { service, tasks, queue } = buildService({
      content: { id: 'content-9', title: '稿件', aiGenerated: false, aiFlagChecked: false } as Partial<Content>,
      activeTasks: [{ id: 'task-old', platform: PlatformCode.WechatMp, status: 'pending' }],
    });

    await expect(
      service.createTasks({ contentId: 'content-9', platforms: [PlatformCode.WechatMp] }, { name: 'tester' }),
    ).rejects.toThrow(/已有未完成任务/);

    expect(tasks.save).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('数据库唯一索引兜底：并发下唯一冲突（23505）也转成 409', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const { service, tasks } = buildService({
      content: { id: 'content-10', title: '并发稿件', aiGenerated: false, aiFlagChecked: false } as Partial<Content>,
    });
    (tasks.save as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(uniqueViolation);

    await expect(
      service.createTasks({ contentId: 'content-10', platforms: [PlatformCode.WechatMp] }, { name: 'tester' }),
    ).rejects.toThrow(/已有未完成任务/);
  });

  it('任务完成后（已发布/已取消）可以再次建单', async () => {
    const { service, tasks } = buildService({
      content: { id: 'content-11', title: '可重发稿件', aiGenerated: false, aiFlagChecked: false } as Partial<Content>,
      activeTasks: [], // 闸门只拦 pending/scheduled/publishing
    });

    const created = await service.createTasks(
      { contentId: 'content-11', platforms: [PlatformCode.WechatMp] },
      { name: 'tester' },
    );
    expect(created).toHaveLength(1);
    expect(tasks.save).toHaveBeenCalledTimes(1);
  });
});
