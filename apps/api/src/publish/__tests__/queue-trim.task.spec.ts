import { describe, expect, it, vi, afterEach } from 'vitest';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { NotificationService } from '../../modules/notification/notification.service';
import { applyRuntimeConfig } from '../../modules/settings/runtime-config';
import { QueueTrimTask } from '../queue-trim.task';
import { PublishQueueService } from '../publish.queue';

function build(options: { lengths: number[]; floor?: string | null; removed?: number }) {
  const lengths = [...options.lengths];
  const queue = {
    length: vi.fn(async () => lengths.shift() ?? 0),
    pendingFloor: vi.fn(async () => options.floor ?? null),
    trim: vi.fn(async () => ({ removed: options.removed ?? 0, floor: options.floor ?? null })),
  } as unknown as PublishQueueService;
  const notify = vi.fn(async (_input: unknown) => ({}));
  const notifications = { notify } as unknown as NotificationService;
  const auditRecord = vi.fn(async (_input: unknown) => undefined);
  const audit = { record: auditRecord } as unknown as AuditService;
  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: 't-1', workspaceId: 'w-1' })),
  } as unknown as WorkspaceContextService;
  return { task: new QueueTrimTask(queue, notifications, audit, workspaceContext), notify, auditRecord, queue };
}

describe('队列修剪定时任务与容量告警（决策 3）', () => {
  afterEach(() => applyRuntimeConfig({}));

  it('容量正常时不告警、不写溢出审计', async () => {
    const { task, notify, auditRecord } = build({ lengths: [100, 100], removed: 0 });
    const result = await task.trimQueue();

    expect(result.alerted).toBe(false);
    expect(result.overflow).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('超过上限 2 倍：发出告警，文案含当前长度/上限/最早未确认 ID', async () => {
    const { task, notify, auditRecord } = build({ lengths: [25000, 25000], floor: '1789746689793-0', removed: 3 });
    const result = await task.trimQueue();

    expect(result.alerted).toBe(true);
    expect(result.overflow).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][0] as unknown as { level: string; title: string; body: string; payload: Record<string, unknown> };
    expect(payload.level).toBe('warning');
    expect(payload.body).toContain('25000');
    expect(payload.body).toContain('10000');
    expect(payload.body).toContain('1789746689793-0');
    expect(payload.payload).toMatchObject({ lengthAfter: 25000, maxLen: 10000, floor: '1789746689793-0' });
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('超过上限 10 倍：升级为 error 并额外写审计 queue.trim.overflow', async () => {
    const { task, notify, auditRecord } = build({ lengths: [120000, 120000], floor: null, removed: 0 });
    const result = await task.trimQueue();

    expect(result.overflow).toBe(true);
    expect((notify.mock.calls[0][0] as unknown as { level: string }).level).toBe('error');
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const entry = auditRecord.mock.calls[0][0] as unknown as { action: string; payload: Record<string, unknown> };
    expect(entry.action).toBe('queue.trim.overflow');
    expect(entry.payload).toMatchObject({ lengthAfter: 120000, maxLen: 10000, threshold: 100000 });
  });

  it('告警阈值随配置上限变化（上限 1000 → 2001 条即告警）', async () => {
    applyRuntimeConfig({ PUBLISH_STREAM_MAXLEN: '1000' });
    const { task, notify } = build({ lengths: [2001, 2001], removed: 0 });
    const result = await task.trimQueue();

    expect(result.maxLen).toBe(1000);
    expect(result.alerted).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('告警通知不带非法 resourceId（库里的 resource_id 是 uuid 列）', async () => {
    const { task, notify } = build({ lengths: [25000, 25000], floor: 'x-1', removed: 0 });
    await task.trimQueue();

    const payload = notify.mock.calls[0][0] as unknown as { resourceId?: unknown; payload: Record<string, unknown> };
    expect(payload.resourceId).toBeNull();
    expect((payload.payload as { stream: string }).stream).toBe('mediaflow:publish:tasks');
  });

  it('告警通知失败不影响修剪结果', async () => {
    const { task, notify } = build({ lengths: [30000, 30000], removed: 1 });
    notify.mockRejectedValueOnce(new Error('webhook down'));

    await expect(task.trimQueue()).resolves.toMatchObject({ alerted: true, removed: 1 });
  });
});
