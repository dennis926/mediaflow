import { afterEach, describe, expect, it, vi } from 'vitest';
import { LessThan, Repository } from 'typeorm';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { NotificationCleanupTask } from '../notification-cleanup.task';
import { Notification } from '../entities/notification.entity';

function buildTask(): { task: NotificationCleanupTask; notifications: Repository<Notification> } {
  const notifications = { delete: vi.fn(async () => ({ affected: 3 })) } as unknown as Repository<Notification>;
  return { task: new NotificationCleanupTask(notifications), notifications };
}

function cutoffOf(notifications: Repository<Notification>): Date {
  const calls = (notifications.delete as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const criterion = calls[0][0] as { createdAt: ReturnType<typeof LessThan> };
  return criterion.createdAt.value as Date;
}

describe('NotificationCleanupTask（通知保留天数可配置）', () => {
  afterEach(() => applyRuntimeConfig({}));

  it('默认保留 90 天，删除更早的通知', async () => {
    const { task, notifications } = buildTask();
    const result = await task.pruneOldNotifications();

    expect(result.removed).toBe(3);
    const days = (Date.now() - cutoffOf(notifications).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it('保留天数填 0 时永久保留，不执行删除', async () => {
    applyRuntimeConfig({ NOTIFICATION_RETENTION_DAYS: '0' });
    const { task, notifications } = buildTask();

    expect(await task.pruneOldNotifications()).toEqual({ removed: 0 });
    expect(notifications.delete).not.toHaveBeenCalled();
  });

  it('自定义 30 天后按新阈值删除', async () => {
    applyRuntimeConfig({ NOTIFICATION_RETENTION_DAYS: '30' });
    const { task, notifications } = buildTask();
    await task.pruneOldNotifications();

    expect(Math.round((Date.now() - cutoffOf(notifications).getTime()) / 86_400_000)).toBe(30);
  });

  it('数据库报错时不抛出（定时任务不能因为清理失败而崩）', async () => {
    const notifications = {
      delete: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as Repository<Notification>;
    const task = new NotificationCleanupTask(notifications);
    await expect(task.pruneOldNotifications()).resolves.toEqual({ removed: 0 });
  });
});
