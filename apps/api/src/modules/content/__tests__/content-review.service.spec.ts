import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../audit/audit.service';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { NotificationService } from '../../notification/notification.service';
import { ContentReviewService } from '../content-review.service';
import { ContentReview } from '../entities/content-review.entity';
import { Content } from '../entities/content.entity';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function repo<T extends ObjectLiteral>(overrides: Partial<Record<string, unknown>> = {}): Repository<T> {
  return {
    findOne: vi.fn(async () => null),
    find: vi.fn(async () => []),
    save: vi.fn(async (value: unknown) => ({ ...(value as object), id: 'review-1' })),
    create: vi.fn((value: unknown) => value),
    update: vi.fn(async () => ({ affected: 1 })),
    count: vi.fn(async () => 1),
    createQueryBuilder: vi.fn(),
    ...overrides,
  } as unknown as Repository<T>;
}

function buildService(options: { content?: Partial<Content> | null; pending?: Partial<ContentReview> | null; review?: Partial<ContentReview> | null }) {
  const contents = repo<Content>({
    findOne: vi.fn(async () => (options.content ?? null) as Content | null),
  });
  const reviews = repo<ContentReview>({
    findOne: vi.fn(async () => (options.pending ?? options.review ?? null) as ContentReview | null),
  });
  const queryBuilder = {
    leftJoin: vi.fn().mockReturnThis(),
    addSelect: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    getRawOne: vi.fn(async () => ({ max: '0' })),
    getManyAndCount: vi.fn(async () => [[], 0]),
  };
  (reviews.createQueryBuilder as unknown as ReturnType<typeof vi.fn>).mockReturnValue(queryBuilder);

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const notifications = { notify: vi.fn(async () => undefined) } as unknown as NotificationService;
  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;

  return { service: new ContentReviewService(contents, reviews, audit, notifications, workspaceContext), contents, reviews, audit, notifications };
}

const draft = { id: 'c1', title: '标题', body: '正文', status: 'draft', workspaceId: WORKSPACE_ID } as unknown as Content;

describe('ContentReviewService 提交', () => {
  it('空内容不能提交审核', async () => {
    const { service } = buildService({ content: { ...draft, body: '   ' } as Content });
    await expect(service.submit({ contentId: 'c1' }, { id: 'u1', name: '编辑' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('已有待审核记录时拒绝重复提交', async () => {
    const { service } = buildService({ content: draft, pending: { id: 'r1', round: 1, status: 'pending' } });
    await expect(service.submit({ contentId: 'c1' }, { id: 'u1', name: '编辑' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('提交成功会把内容置为审核中并通知', async () => {
    const { service, contents, notifications, audit } = buildService({ content: draft, pending: null });
    const review = await service.submit({ contentId: 'c1', comments: '请审核' }, { id: 'u1', name: '编辑' });

    expect(review.round).toBe(1);
    expect(contents.update).toHaveBeenCalledWith({ id: 'c1' }, { status: 'reviewing' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'review.submitted' }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'review.submit', actorId: 'u1' }));
  });
});

describe('ContentReviewService 审核决定', () => {
  // factory: the service mutates the entity it loads, so every test needs a fresh copy
  const pendingReview = () => ({
    id: 'r1',
    contentId: 'c1',
    round: 1,
    status: 'pending',
    submittedBy: 'author-1',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
  }) as unknown as ContentReview;

  it('不能审核自己提交的内容', async () => {
    const { service } = buildService({ content: draft, review: pendingReview() });
    await expect(service.decide('r1', { decision: 'approved' }, { id: 'author-1', name: '作者' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('驳回时必须填写原因', async () => {
    const { service } = buildService({ content: draft, review: pendingReview() });
    await expect(service.decide('r1', { decision: 'rejected' }, { id: 'reviewer-1', name: '审核人' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('通过后内容状态变为已通过并通知提交人', async () => {
    const { service, contents, notifications } = buildService({ content: draft, review: pendingReview() });
    await service.decide('r1', { decision: 'approved' }, { id: 'reviewer-1', name: '审核人' });

    expect(contents.update).toHaveBeenCalledWith({ id: 'c1' }, { status: 'approved' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'review.approved' }));
  });

  it('要求修改会把内容退回草稿', async () => {
    const { service, contents } = buildService({ content: draft, review: pendingReview() });
    await service.decide('r1', { decision: 'changes_requested', comments: '请补充数据来源' }, { id: 'reviewer-1', name: '审核人' });

    expect(contents.update).toHaveBeenCalledWith({ id: 'c1' }, { status: 'draft' });
  });

  it('已处理的审核记录不能重复处理', async () => {
    const { service } = buildService({
      content: draft,
      review: { ...pendingReview(), status: 'approved' } as unknown as ContentReview,
    });
    await expect(service.decide('r1', { decision: 'approved' }, { id: 'reviewer-1', name: '审核人' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
