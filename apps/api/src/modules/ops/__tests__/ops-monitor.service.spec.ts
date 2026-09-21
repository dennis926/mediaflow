import { describe, expect, it, vi, afterEach } from 'vitest';
import type Redis from 'ioredis';
import type { Repository } from 'typeorm';
import { AiGeneration } from '../../ai/entities/ai-generation.entity';
import { PublishTask } from '../../publish/entities/publish-task.entity';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import type { PublishQueueService } from '../../../publish/publish.queue';
import type { AuditService } from '../../../audit/audit.service';
import type { NotificationService } from '../../notification/notification.service';
import type { WorkspaceContextService } from '../../../common/workspace-context.service';
import { OpsMonitorService } from '../ops-monitor.service';

/**
 * 类别 6（监控）单测：六类阈值的命中/不命中边界，
 * 以及"告警文案必须自带当前值、阈值、时间、排查入口"。
 */
function build(options: {
  queueLength?: number;
  pendingIdleMs?: number | null;
  tasks?: { total: number; failed: number } | { rows: Array<{ tokens: string }> };
  tokens?: string;
  windowFailures?: string | null;
  setResult?: string | null;
} = {}) {
  const queue = {
    length: vi.fn(async () => options.queueLength ?? 0),
    oldestPendingIdleMs: vi.fn(async () => options.pendingIdleMs ?? null),
  } as unknown as PublishQueueService;

  const redis = {
    get: vi.fn(async () => options.windowFailures ?? null),
    // setResult 未显式给出时返回 'OK'（拿到闸门）；显式传 null 表示"已被冷却挡住"
    set: vi.fn(async () => (options.setResult === undefined ? 'OK' : options.setResult)),
  } as unknown as Redis;

  const tasksRepo = {
    createQueryBuilder: () => ({
      select: () => ({
        addSelect: () => ({
          where: () => ({
            getRawOne: async () => ({
              total: String((options.tasks as { total?: number })?.total ?? 0),
              failed: String((options.tasks as { failed?: number })?.failed ?? 0),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Repository<PublishTask>;

  const generationsRepo = {
    createQueryBuilder: () => ({
      select: () => ({
        where: () => ({ getRawOne: async () => ({ tokens: options.tokens ?? '0' }) }),
      }),
    }),
  } as unknown as Repository<AiGeneration>;

  const notify = vi.fn(async (_input: unknown) => undefined);
  const notifications = { notify } as unknown as NotificationService;
  const auditRecord = vi.fn(async (_input: unknown) => undefined);
  const audit = { record: auditRecord } as unknown as AuditService;
  const workspaceContext = { current: async () => ({ tenantId: 't1', workspaceId: 'w1' }) } as unknown as WorkspaceContextService;

  const service = new OpsMonitorService(queue, redis, tasksRepo, generationsRepo, notifications, audit, workspaceContext, dataSourceStub);
  return { service, notify, auditRecord, redis, queue };
}

afterEach(() => applyRuntimeConfig({}));

const dataSourceStub = {
  query: vi.fn(async () => [{ n: 0 }]),
} as unknown as import('typeorm').DataSource;

describe('运行监控：六类阈值（第 6 项）', () => {
  it('1. 队列积压：超过阈值命中，等于阈值不命中', async () => {
    applyRuntimeConfig({ MONITOR_QUEUE_LENGTH_THRESHOLD: '100' });
    const over = await build({ queueLength: 101 }).service.checkQueueLength();
    expect(over.key).toBe('queue_length');
    expect(over.triggered).toBe(true);
    expect(over.current).toBe(101);

    const equal = await build({ queueLength: 100 }).service.checkQueueLength();
    expect(equal.triggered).toBe(false);
  });

  it('2. 未确认消息滞留：超过阈值命中（error 级），无未确认消息不命中', async () => {
    applyRuntimeConfig({ MONITOR_PENDING_AGE_SECONDS: '300' });
    const aged = await build({ pendingIdleMs: 301_000 }).service.checkPendingAge();
    expect(aged.triggered).toBe(true);
    expect(aged.level).toBe('error');
    expect(aged.current).toBe(301);

    const none = await build({ pendingIdleMs: null }).service.checkPendingAge();
    expect(none.triggered).toBe(false);
    expect(none.detail).toContain('没有未确认消息');
  });

  it('3. 发布失败率：样本足够且超阈值命中；样本不足即使比例高也不报', async () => {
    applyRuntimeConfig({ MONITOR_FAILURE_RATE_PERCENT: '10', MONITOR_FAILURE_MIN_SAMPLE: '5' });
    const failing = await build({ tasks: { total: 10, failed: 2 } }).service.checkPublishFailureRate();
    expect(failing.triggered).toBe(true);
    expect(failing.current).toBe(20);

    const tinySample = await build({ tasks: { total: 4, failed: 2 } }).service.checkPublishFailureRate();
    expect(tinySample.triggered).toBe(false);
    expect(tinySample.detail).toContain('样本少于');
  });

  it('4. 登录失败：窗口计数超过阈值命中（error 级）', async () => {
    applyRuntimeConfig({ MONITOR_LOGIN_FAIL_THRESHOLD: '20', MONITOR_LOGIN_FAIL_WINDOW_MINUTES: '5' });
    const attack = await build({ windowFailures: '21' }).service.checkLoginFailures();
    expect(attack.triggered).toBe(true);
    expect(attack.level).toBe('error');
    expect(attack.detail).toContain('爆破');

    const quiet = await build({ windowFailures: '20' }).service.checkLoginFailures();
    expect(quiet.triggered).toBe(false);
  });

  it('5. 磁盘使用率：用极低阈值可以稳定命中（真实 statfs 读取）', async () => {
    applyRuntimeConfig({ MONITOR_DISK_USED_PERCENT: '1' });
    const hot = await build().service.checkUploadDisk();
    expect(hot.triggered).toBe(true);
    expect(hot.current).toBeGreaterThan(1);

    applyRuntimeConfig({ MONITOR_DISK_USED_PERCENT: '100' });
    const cool = await build().service.checkUploadDisk();
    expect(cool.triggered).toBe(false);
  });

  it('6. AI 配额：达到比例命中；未配置配额时跳过且不报错', async () => {
    applyRuntimeConfig({ AI_DAILY_TOKEN_QUOTA: '1000', MONITOR_AI_QUOTA_PERCENT: '80' });
    const near = await build({ tokens: '900' }).service.checkAiQuota();
    expect(near.triggered).toBe(true);
    expect(near.current).toBe(90);

    applyRuntimeConfig({ AI_DAILY_TOKEN_QUOTA: '0' });
    const unset = await build({ tokens: '900' }).service.checkAiQuota();
    expect(unset.triggered).toBe(false);
    expect(unset.detail).toContain('未配置');
  });
});

describe('运行监控：告警文案与冷却（第 6 项）', () => {
  it('命中后发通知：文案含当前值、阈值、检查时间与排查入口', async () => {
    applyRuntimeConfig({ MONITOR_QUEUE_LENGTH_THRESHOLD: '1', MONITOR_OPS_BASE_URL: 'https://example.com' });
    const { service, notify } = build({ queueLength: 9 });

    const result = await service.runAll();

    expect(result.emitted).toContain('queue_length');
    const sent = notify.mock.calls[0][0] as { body: string; title: string; type: string; external: boolean };
    expect(sent.type).toBe('ops.monitor.queue_length');
    expect(sent.external).toBe(true);
    expect(sent.body).toContain('当前值：9条');
    expect(sent.body).toContain('阈值：1条');
    expect(sent.body).toContain('检查时间：');
    expect(sent.body).toContain('排查入口：https://example.com/publish/queue');
  });

  it('冷却期内同类告警不重复发送（suppressed）', async () => {
    applyRuntimeConfig({ MONITOR_QUEUE_LENGTH_THRESHOLD: '1' });
    const { service, notify } = build({ queueLength: 9, setResult: null });

    const result = await service.runAll();

    expect(result.checks.some((check) => check.triggered)).toBe(true);
    expect(result.emitted).toHaveLength(0);
    expect(result.suppressed).toContain('queue_length');
    expect(notify).not.toHaveBeenCalled();
  });

  it('error 级告警同时落审计（便于事后追溯）', async () => {
    applyRuntimeConfig({ MONITOR_PENDING_AGE_SECONDS: '0' });
    const { service, auditRecord } = build({ pendingIdleMs: 5_000 });

    const result = await service.runAll();

    expect(result.emitted).toContain('queue_pending_age');
    expect(auditRecord).toHaveBeenCalled();
  });
});
