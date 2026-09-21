import type { QuotaService } from '../../billing/quota.service';
import type { DataDeletionRequest } from '../entities/data-deletion-request.entity';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Repository } from 'typeorm';
import type { AuditService } from '../../../audit/audit.service';
import type { AuthSessionService } from '../../auth/auth-session.service';
import type { NotificationService } from '../../notification/notification.service';
import type { WorkspaceContextService } from '../../../common/workspace-context.service';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { Workspace } from '../entities/workspace.entity';
import { WorkspaceMember } from '../entities/workspace-member.entity';
import { User } from '../entities/user.entity';
import { WorkspaceExportJob } from '../entities/workspace-export-job.entity';
import { PublishTask } from '../../publish/entities/publish-task.entity';
import { WorkspaceService } from '../workspace.service';

/**
 * B0.4 状态机单测：归档/取消归档/软删/恢复的分支与前置校验，
 * 以及"按目标工作区判权限"的三条边界（不存在 / 非成员 / 非 owner）。
 */
const WS_ID = 'w-1';
const USER_ID = 'u-1';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: WS_ID,
    tenantId: 't-1',
    workspaceId: WS_ID,
    name: '测试工作区',
    slug: 'test',
    status: 'active',
    settings: {},
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Workspace;
}

function build(options: {
  workspace?: Workspace | null;
  member?: Record<string, unknown> | null;
  activeTasks?: number;
  runningExports?: number;
  /** 同一租户内其它仍可用的工作区数量（0 = 这是最后一个） */
  otherWorkspaces?: number;
} = {}) {
  const current = options.workspace === undefined ? workspace() : options.workspace;
  const store = new Map<string, Workspace>();
  if (current) store.set(current.id, current);

  const workspaces = {
    findOne: vi.fn(async () => (store.get(WS_ID) ?? null) as Workspace | null),
    findOneOrFail: vi.fn(async () => store.get(WS_ID) as Workspace),
    find: vi.fn(async () => [...store.values()]),
    update: vi.fn(async (_criteria: unknown, patch: Partial<Workspace>) => {
      const row = store.get(WS_ID);
      if (row) store.set(WS_ID, { ...row, ...patch } as Workspace);
      return { affected: 1 };
    }),
    count: vi.fn(async () => options.otherWorkspaces ?? 1),
    save: vi.fn(async (value: unknown) => value),
    create: vi.fn((value: unknown) => value),
  } as unknown as Repository<Workspace>;

  const members = {
    findOne: vi.fn(async () => (options.member === undefined ? { roleCodes: ['owner'] } : options.member)),
    find: vi.fn(async () => []),
    save: vi.fn(async (value: unknown) => value),
    create: vi.fn((value: unknown) => value),
  } as unknown as Repository<WorkspaceMember>;

  const users = { count: vi.fn(async () => 1), findOne: vi.fn(async () => null) } as unknown as Repository<User>;
  const tasks = { count: vi.fn(async () => options.activeTasks ?? 0) } as unknown as Repository<PublishTask>;
  const exportJobs = { count: vi.fn(async () => options.runningExports ?? 0) } as unknown as Repository<WorkspaceExportJob>;
  const workspaceContext = { current: async () => ({ tenantId: 't-1', workspaceId: WS_ID }) } as unknown as WorkspaceContextService;
  const auditRecord = vi.fn(async (_input: unknown) => undefined);
  const audit = { record: auditRecord } as unknown as AuditService;
  const invalidateWorkspace = vi.fn(async () => 1);
  const sessions = { invalidate: vi.fn(async () => 1), invalidateWorkspace } as unknown as AuthSessionService;

  const notify = vi.fn(async (_input: unknown) => undefined);
  const notifications = { notify } as unknown as NotificationService;

  // B0.6：合规删除请求台账（默认没有未完成请求）
  const deletionRequests = {
    findOne: vi.fn(async () => null),
    find: vi.fn(async () => []),
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: unknown) => value),
    update: vi.fn(async () => ({ affected: 1 })),
  } as unknown as Repository<DataDeletionRequest>;

  const quotaStub = {
    assertQuota: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  } as unknown as QuotaService;
  const service = new WorkspaceService(
    workspaces,
    members,
    users,
    tasks,
    exportJobs,
    deletionRequests,
    notifications,
    workspaceContext,
    audit,
    sessions,
    quotaStub,
  );
  return { service, auditRecord, invalidateWorkspace, tasks, exportJobs, notify, store };
}

const actor = { id: USER_ID, name: '操作人' };

afterEach(() => applyRuntimeConfig({}));

describe('B0.4 归档 / 取消归档', () => {
  it('归档：active → archived，写审计并使全体成员缓存失效', async () => {
    const { service, auditRecord, invalidateWorkspace } = build();
    const view = await service.archiveWorkspace(WS_ID, USER_ID, actor);

    expect(view.status).toBe('archived');
    expect(view.archivedAt).toBeTruthy();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace.archive' }));
    expect(invalidateWorkspace).toHaveBeenCalledWith(WS_ID);
  });

  it('重复归档 → 409', async () => {
    const { service } = build({ workspace: workspace({ status: 'archived' }) });
    await expect(service.archiveWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/已处于归档状态/);
  });

  it('已软删的工作区不能归档（需先恢复）→ 409', async () => {
    const { service } = build({ workspace: workspace({ status: 'soft_deleted' }) });
    await expect(service.archiveWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/请先恢复/);
  });

  it('取消归档：archived → active 并清空归档时间', async () => {
    const { service } = build({ workspace: workspace({ status: 'archived', archivedAt: new Date() }) });
    const view = await service.unarchiveWorkspace(WS_ID, USER_ID, actor);
    expect(view.status).toBe('active');
    expect(view.archivedAt).toBeNull();
  });

  it('非归档态不能取消归档 → 409', async () => {
    const { service } = build();
    await expect(service.unarchiveWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/不是归档状态/);
  });
});

describe('B0.4 软删', () => {
  it('名称不匹配 → 400，且不写库', async () => {
    const { service, auditRecord } = build();
    await expect(service.softDeleteWorkspace(WS_ID, USER_ID, '写错的名称', actor)).rejects.toThrow(/名称不匹配/);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('有未完成发布任务 → 409', async () => {
    const { service } = build({ activeTasks: 3 });
    await expect(service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor)).rejects.toThrow(/未完成的发布任务/);
  });

  it('有进行中的导出任务 → 409', async () => {
    const { service } = build({ runningExports: 1 });
    await expect(service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor)).rejects.toThrow(/正在进行的导出任务/);
  });

  it('软删成功：写入保留期与到期时间（读配置，不写死）', async () => {
    applyRuntimeConfig({ WORKSPACE_SOFT_DELETE_RETENTION_DAYS: '7' });
    const { service, auditRecord, invalidateWorkspace } = build();
    const view = await service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor, '合规要求');

    expect(view.status).toBe('soft_deleted');
    expect(view.daysUntilPurge).toBe(7);
    expect(view.deletedAt).toBeTruthy();
    expect(invalidateWorkspace).toHaveBeenCalledWith(WS_ID);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.soft_delete', payload: expect.objectContaining({ retentionDays: 7 }) }),
    );
  });

  it('已软删的工作区再次软删 → 409', async () => {
    const { service } = build({ workspace: workspace({ status: 'soft_deleted' }) });
    await expect(service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor)).rejects.toThrow(/已被删除/);
  });
});

describe('B0.4 恢复', () => {
  it('非软删态 → 409', async () => {
    const { service } = build();
    await expect(service.restoreWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/不需要恢复/);
  });

  it('保留期内 → 恢复为 active 并清空删除信息', async () => {
    const { service } = build({
      workspace: workspace({ status: 'soft_deleted', deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86400000) }),
    });
    const view = await service.restoreWorkspace(WS_ID, USER_ID, actor);
    expect(view.status).toBe('active');
    expect(view.deletedAt).toBeNull();
    expect(view.purgeAfter).toBeNull();
  });

  it('超过保留期 → 410（明确不可恢复）', async () => {
    const { service } = build({
      workspace: workspace({ status: 'soft_deleted', deletedAt: new Date(Date.now() - 86400000), purgeAfter: new Date(Date.now() - 1000) }),
    });
    await expect(service.restoreWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/超过保留期/);
  });
});

describe('B0.4 按目标工作区判权限（requireWorkspaceRole）', () => {
  it('工作区不存在 → 404', async () => {
    const { service } = build({ workspace: null });
    await expect(service.archiveWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/工作区不存在/);
  });

  it('不是该工作区成员 → 404（不泄露存在性）', async () => {
    const { service } = build({ member: null });
    await expect(service.archiveWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/工作区不存在/);
  });

  it('是成员但不是 owner → 403', async () => {
    const { service } = build({ member: { roleCodes: ['editor'] } });
    await expect(service.archiveWorkspace(WS_ID, USER_ID, actor)).rejects.toThrow(/只有该工作区的所有者/);
  });

  it('软删态的工作区，其 owner 依然能通过权限判定（否则无法恢复）', async () => {
    const { service } = build({ workspace: workspace({ status: 'soft_deleted', purgeAfter: new Date(Date.now() + 86400000) }) });
    await expect(service.restoreWorkspace(WS_ID, USER_ID, actor)).resolves.toMatchObject({ status: 'active' });
  });
});

describe('B0.4 最后一个工作区的软保护（决策 2）', () => {
  it('是最后一个工作区且未确认 → 400，并给出确认方式；不写库、不审计', async () => {
    const { service, auditRecord } = build({ otherWorkspaces: 0 });
    await expect(service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor)).rejects.toThrow(/最后一个工作区/);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('是最后一个工作区但显式确认 → 200，写专用审计并发出站内＋外部通知', async () => {
    const { service, auditRecord, notify } = build({ otherWorkspaces: 0 });
    const view = await service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor, '关停账号', true);

    expect(view.status).toBe('soft_deleted');
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.soft_delete.last_workspace', payload: expect.objectContaining({ wasLast: true }) }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workspace.soft_delete.last_workspace', external: true }),
    );
  });

  it('还有其它工作区时不触发软保护（无需 confirmLastWorkspace）', async () => {
    const { service, notify } = build({ otherWorkspaces: 2 });
    const view = await service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor);
    expect(view.status).toBe('soft_deleted');
    expect(notify).not.toHaveBeenCalled();
  });

  it('普通软删的审计里带有 wasLast=false（便于统计）', async () => {
    const { service, auditRecord } = build({ otherWorkspaces: 1 });
    await service.softDeleteWorkspace(WS_ID, USER_ID, '测试工作区', actor);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.soft_delete', payload: expect.objectContaining({ wasLast: false }) }),
    );
  });
});
