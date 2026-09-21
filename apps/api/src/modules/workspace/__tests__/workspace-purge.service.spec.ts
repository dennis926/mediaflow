import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type { AuditService } from '../../../audit/audit.service';
import type { AuthSessionService } from '../../auth/auth-session.service';
import type { NotificationChannelService } from '../../notification/notification-channel.service';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import type { WorkspaceExportJob } from '../entities/workspace-export-job.entity';
import type { WorkspacePurgeBatch } from '../entities/workspace-purge-batch.entity';
import { BACKUP_TABLES, WorkspacePurgeService } from '../workspace-purge.service';
import type { WorkspaceService } from '../workspace.service';

/**
 * B0.4 第 4 步：永久清除的前置校验与"备份失败即中止"。
 * 数据库与 pg_dump 全部替身化——这条链路的正确性靠单测保证顺序与门槛，端到端由 `RUNBOOK-purge演练.md` 的演练覆盖。
 */
const WS_ID = 'w-purge-1';
const USER_ID = 'u-owner';

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: WS_ID,
    name: '演练工作区',
    slug: 'drill',
    tenantId: 't-1',
    status: 'soft_deleted',
    purgeAfter: new Date(Date.now() - 3600_000), // 已过保留期
    deletedAt: new Date(Date.now() - 2 * 86400_000),
    archivedAt: null,
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build(options: {
  workspace?: Record<string, unknown> | null;
  runningExports?: number;
  backupFails?: boolean;
  deletedRows?: Record<string, number>;
} = {}) {
  const ws = options.workspace === undefined ? workspace() : options.workspace;
  const workspaces = {
    requireWorkspaceRole: vi.fn(async () => ({ workspace: ws, roleCodes: ['owner'] })),
  } as unknown as WorkspaceService;

  const batchRow = { id: 'batch-1' };
  const batches = {
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async () => batchRow),
    update: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(() => ({ where: vi.fn().mockReturnThis(), getMany: vi.fn(async () => []) })),
  } as unknown as Repository<WorkspacePurgeBatch>;

  const exportJobs = { count: vi.fn(async () => options.runningExports ?? 0) } as unknown as Repository<WorkspaceExportJob>;

  const deletedRows = options.deletedRows ?? { contents: 3, content_variants: 2, social_accounts: 1, workspace_members: 1 };
  const manager = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT count(*)')) {
        const table = sql.match(/FROM (\w+)/)?.[1] ?? '';
        return [{ n: deletedRows[table] ?? 0 }];
      }
      return [];
    }),
  };
  const dataSource = {
    transaction: vi.fn(async (fn: (m: unknown) => Promise<void>) => fn(manager)),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM media_assets')) return [{ stored_name: 'a.png' }];
      if (sql.includes('FROM brand_knowledge')) return [{ source_url: null }];
      return [];
    }),
  } as unknown as DataSource;

  const auditRecord = vi.fn(async (_input: unknown) => undefined);
  const audit = { record: auditRecord } as unknown as AuditService;
  // purge 完成只走外部渠道（站内通知会落进已被清除的工作区，实测会残留 1 行）
  const dispatch = vi.fn(async (_message: unknown) => [{ channel: 'email' as const, ok: true }]);
  const channels = { available: vi.fn(() => ['email']), dispatch } as unknown as NotificationChannelService;
  const invalidateWorkspace = vi.fn(async () => 1);
  const sessions = { invalidateWorkspace } as unknown as AuthSessionService;
  const config = { get: vi.fn(() => undefined) } as unknown as ConfigService;

  const service = new WorkspacePurgeService(batches, exportJobs, dataSource, workspaces, audit, channels, sessions, config);
  if (options.backupFails) {
    // 备份失败场景：模拟"备份目录不可写"
    vi.spyOn(service, 'backupWorkspace').mockRejectedValue(new Error('备份目录不可写（EACCES）'));
  } else {
    // 成功路径：备份本身由 RUNBOOK-purge演练.md 的真实演练覆盖，这里只验证流程编排
    vi.spyOn(service, 'backupWorkspace').mockResolvedValue({
      path: '/tmp/drill-backup.sql.gz',
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
    });
  }
  vi.spyOn(service, 'deleteFiles').mockResolvedValue({ deletedFiles: 1, failures: [] });
  return { service, batches, auditRecord, dispatch, invalidateWorkspace, manager };
}

const dto = { confirmName: '演练工作区', confirmText: '永久删除', reason: '演练' };
const actor = { id: USER_ID, name: '演练操作人' };

afterEach(() => {
  applyRuntimeConfig({});
  vi.restoreAllMocks();
});

describe('B0.4 永久清除：前置校验', () => {
  it('未软删 → 409', async () => {
    const { service } = build({ workspace: workspace({ status: 'active' }) });
    await expect(service.purgeWorkspace(WS_ID, USER_ID, dto, actor)).rejects.toThrow(/尚未删除/);
  });

  it('保留期未结束 → 409 并提示剩余天数', async () => {
    const { service } = build({ workspace: workspace({ purgeAfter: new Date(Date.now() + 5 * 86400_000) }) });
    await expect(service.purgeWorkspace(WS_ID, USER_ID, dto, actor)).rejects.toThrow(/保留期未结束/);
  });

  it('名称不匹配 → 400', async () => {
    const { service } = build();
    await expect(service.purgeWorkspace(WS_ID, USER_ID, { ...dto, confirmName: '写错' }, actor)).rejects.toThrow(/名称不匹配/);
  });

  it('二次确认串不对 → 400', async () => {
    const { service } = build();
    await expect(service.purgeWorkspace(WS_ID, USER_ID, { ...dto, confirmText: '删除' }, actor)).rejects.toThrow(/二次确认不正确/);
  });

  it('有进行中的导出任务 → 409', async () => {
    const { service } = build({ runningExports: 1 });
    await expect(service.purgeWorkspace(WS_ID, USER_ID, dto, actor)).rejects.toThrow(/导出任务/);
  });
});

describe('B0.4 永久清除：备份失败即中止（硬约束）', () => {
  it('备份失败 → 503、不进入删除流程、账本记为 failed、写 purge_failed 审计', async () => {
    const { service, manager, auditRecord, batches } = build({ backupFails: true });

    await expect(service.purgeWorkspace(WS_ID, USER_ID, dto, actor)).rejects.toThrow(/备份失败/);

    // 关键：一条数据都没删
    expect(manager.query).not.toHaveBeenCalled();
    expect(batches.update).toHaveBeenCalledWith(
      { id: 'batch-1' },
      expect.objectContaining({ status: 'failed' }),
    );
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace.purge_failed' }));
  });
});

describe('B0.4 永久清除：成功路径', () => {
  it('备份成功 → 删行（单事务）→ 清理缓存 → 写 completed 账本与三条审计 → 只走外部通报', async () => {
    const { service, batches, auditRecord, dispatch, invalidateWorkspace } = build({
      deletedRows: { contents: 3, content_variants: 2, social_accounts: 1, media_assets: 1, workspace_members: 1 },
    });
    const result = await service.purgeWorkspace(WS_ID, USER_ID, dto, actor);

    expect(result.deletedRows.contents).toBe(3);
    expect(result.socialAccountsDestroyed).toBe(1);
    expect(result.ledgerRetained).toContain('audit_logs');
    expect(result.ledgerRetained).toContain('ai_generations');
    expect(batches.update).toHaveBeenCalledWith({ id: 'batch-1' }, expect.objectContaining({ status: 'completed' }));
    const actions = (auditRecord as unknown as { mock: { calls: Array<[{ action: string }]> } }).mock.calls.map((call) => call[0].action);
    expect(actions).toContain('workspace.purge_started');
    expect(actions).toContain('workspace.purge_completed');
    expect(actions).toContain('workspace.purge.social_accounts_destroyed');
    expect(invalidateWorkspace).toHaveBeenCalledWith(WS_ID);
    expect(dispatch).toHaveBeenCalled();
  });

  it('审计与成本账本类表不在删除清单里（B 类永久保留）', async () => {
    const { service } = build();
    await service.purgeWorkspace(WS_ID, USER_ID, dto, actor);
    const result = await service.preview(WS_ID, USER_ID);
    for (const ledgerTable of ['audit_logs', 'ai_generations', 'workspace_purge_batches']) {
      expect(Object.keys(result.rows)).not.toContain(ledgerTable);
    }
  });
});

describe('B0.4 备份表顺序（恢复可行性回归）', () => {
  it('备份顺序是「父表在前」：contents 必须出现在所有引用它的表之前', () => {
    const childrenOfContents = ['content_variants', 'content_revisions', 'content_reviews', 'publish_tasks', 'analytics', 'track_events'];
    const contentsIndex = BACKUP_TABLES.indexOf('contents');
    expect(contentsIndex).toBeGreaterThan(-1);
    for (const child of childrenOfContents) {
      const childIndex = BACKUP_TABLES.indexOf(child);
      expect(childIndex).toBeGreaterThan(contentsIndex);
    }
    // 工作区自身要最先（其它行的 workspace_id 可能引用它）
    expect(BACKUP_TABLES[0]).toBe('workspaces');
  });

  it('备份清单覆盖全部 A 类业务表（不能漏）', () => {
    for (const table of ['contents', 'content_variants', 'content_revisions', 'content_reviews', 'publish_tasks',
      'analytics', 'track_events', 'media_assets', 'brand_knowledge', 'content_templates', 'social_accounts',
      'platforms', 'notifications', 'workspace_members', 'workspace_export_jobs']) {
      expect(BACKUP_TABLES).toContain(table);
    }
  });
});
