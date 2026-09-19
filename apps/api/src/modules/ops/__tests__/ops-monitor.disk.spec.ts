import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Repository } from 'typeorm';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { AiGeneration } from '../../ai/entities/ai-generation.entity';
import { PublishTask } from '../../publish/entities/publish-task.entity';
import type { PublishQueueService } from '../../../publish/publish.queue';
import type { AuditService } from '../../../audit/audit.service';
import type { NotificationService } from '../../notification/notification.service';
import type { WorkspaceContextService } from '../../../common/workspace-context.service';

/** 用受控的 statfs 数据驱动检查，避免测试依赖机器真实磁盘占用。 */
const statfsSync = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, statfsSync: (...args: unknown[]) => statfsSync(...args) };
});

// vi.mock 会被提升到 import 之前，因此静态导入同样拿到被 mock 的 statfsSync
import { OpsMonitorService } from '../ops-monitor.service';

function build() {
  const queue = { length: vi.fn(async () => 0), oldestPendingIdleMs: vi.fn(async () => null) } as unknown as PublishQueueService;
  const redis = { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') } as unknown as import('ioredis').default;
  const repo = { createQueryBuilder: () => ({ select: () => ({ addSelect: () => ({ where: () => ({ getRawOne: async () => ({ total: '0', failed: '0' }) }) }) }), where: () => ({ getRawOne: async () => ({ tokens: '0' }) }) }) } as unknown as Repository<PublishTask>;
  const generations = repo as unknown as Repository<AiGeneration>;
  const notifications = { notify: vi.fn(async () => undefined) } as unknown as NotificationService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const workspaceContext = { current: async () => ({ tenantId: 't1', workspaceId: 'w1' }) } as unknown as WorkspaceContextService;
  return new OpsMonitorService(queue, redis, repo, generations, notifications, audit, workspaceContext);
}

afterEach(() => {
  applyRuntimeConfig({});
  statfsSync.mockReset();
});

describe('监控磁盘口径与 df 对齐（B0.2）', () => {
  it('用 bavail 计算（与 df 一致），而不是含保留块的 bfree', async () => {
    // 真实场景取样（2026-09-19）：blocks 18015578、bfree 9605889、bavail 8789217、bsize 4096
    statfsSync.mockReturnValue({ blocks: 18015578, bfree: 9605889, bavail: 8789217, bsize: 4096, files: 0, ffree: 0, type: 0 });
    applyRuntimeConfig({ MONITOR_DISK_USED_PERCENT: '100' });

    const check = await build().checkUploadDisk();

    // 同一时刻 df 显示 49%：本实现 (blocks-bfree)/(blocks-bfree+bavail) = 48.9% ✓ 对齐
    expect(check.current).toBe(48.9);
    // 对照：早期口径（含保留块）会给出 46.7%；朴素的 (blocks-bavail)/blocks 会给 51.2%
    const legacy = ((18015578 - 9605889) / 18015578) * 100;
    const naiveBavail = ((18015578 - 8789217) / 18015578) * 100;
    expect(Math.round(legacy * 10) / 10).toBe(46.7);
    expect(Math.round(naiveBavail * 10) / 10).toBe(51.2);
    expect(check.current).not.toBe(Math.round(legacy * 10) / 10);
    expect(check.current).toBeLessThan(Math.round(naiveBavail * 10) / 10);
  });

  it('阈值判定用同一口径：超过阈值才告警', async () => {
    statfsSync.mockReturnValue({ blocks: 100, bfree: 40, bavail: 20, bsize: 1, files: 0, ffree: 0, type: 0 });
    // used = 60, total = 60 + 20 = 80 → 75%
    applyRuntimeConfig({ MONITOR_DISK_USED_PERCENT: '74' });
    const alerting = await build().checkUploadDisk();
    expect(alerting.current).toBe(75);
    expect(alerting.triggered).toBe(true);

    applyRuntimeConfig({ MONITOR_DISK_USED_PERCENT: '75' });
    const calm = await build().checkUploadDisk();
    expect(calm.triggered).toBe(false);
  });

  it('statfs 读取失败时不影响巡检（返回 0 并说明）', async () => {
    statfsSync.mockImplementation(() => {
      throw new Error('EPERM');
    });
    const check = await build().checkUploadDisk();
    expect(check.triggered).toBe(false);
    expect(check.detail).toContain('无法读取磁盘用量');
  });
});
