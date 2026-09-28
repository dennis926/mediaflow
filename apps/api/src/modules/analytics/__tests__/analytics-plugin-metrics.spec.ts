import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { Analytics } from '../entities/analytics.entity';
import { AnalyticsService } from '../analytics.service';

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';

function buildService(existing: Partial<Analytics> | null): { service: AnalyticsService; snapshots: Repository<Analytics> } {
  const snapshots = {
    findOne: vi.fn(async () => existing as Analytics | null),
    save: vi.fn(async (value: unknown) => ({ ...(value as object), id: 'snapshot-1' })),
    create: vi.fn((value: unknown) => value),
    update: vi.fn(async () => ({ affected: 1 })),
    find: vi.fn(async () => []),
  } as unknown as Repository<Analytics>;

  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: 't', workspaceId: WORKSPACE_ID })),
  } as unknown as WorkspaceContextService;

  const stub = {} as never;
  // 参数顺序：analytics, events, contents, tasks, accounts, workspaceContext, publishService, registry
  const service = new AnalyticsService(snapshots, stub, stub, stub, stub, workspaceContext, stub, stub, auditStub);
  return { service, snapshots };
}

const auditStub = {
  record: vi.fn(async () => undefined),
} as unknown as import('../../../audit/audit.service').AuditService;

describe('插件指标回收：同作品去重（避免多轮回收被累加）', () => {
  it('首次上报插入新快照', async () => {
    const { service, snapshots } = buildService(null);
    const result = await service.savePluginMetrics({ platform: 'wechat_video' as never, postId: 'p1', views: 100, likes: 5 });

    expect(result.id).toBe('snapshot-1');
    expect(snapshots.save).toHaveBeenCalledTimes(1);
    expect(snapshots.update).not.toHaveBeenCalled();
  });

  it('同一 postId 再次上报时更新原快照，而不是新增一行', async () => {
    const { service, snapshots } = buildService({ id: 'existing-1', views: 100 } as Partial<Analytics>);
    const result = await service.savePluginMetrics({ platform: 'wechat_video' as never, postId: 'p1', views: 23180, likes: 1204 });

    expect(result.id).toBe('existing-1');
    expect(snapshots.update).toHaveBeenCalledWith(
      { id: 'existing-1' },
      expect.objectContaining({ views: 23180, likes: 1204 }),
    );
    expect(snapshots.save).not.toHaveBeenCalled();
  });

  it('没有 postId 时按账号级快照去重', async () => {
    const { service, snapshots } = buildService({ id: 'account-snapshot' } as Partial<Analytics>);
    await service.savePluginMetrics({ platform: 'douyin' as never, socialAccountId: 'acc-1', views: 10 });

    expect(snapshots.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ socialAccountId: 'acc-1', platformPostId: expect.anything() }),
      }),
    );
    expect(snapshots.update).toHaveBeenCalledWith({ id: 'account-snapshot' }, expect.objectContaining({ views: 10 }));
  });

  it('保留原有的 extra 字段（例如标记来源），不被覆盖丢失', async () => {
    const { service, snapshots } = buildService({ id: 'existing-1', extra: { keepMe: true } } as Partial<Analytics>);
    await service.savePluginMetrics({ platform: 'douyin' as never, postId: 'p1', views: 1 });

    expect(snapshots.update).toHaveBeenCalledWith(
      { id: 'existing-1' },
      expect.objectContaining({ extra: expect.objectContaining({ keepMe: true, source: 'browser-extension' }) }),
    );
  });
});
