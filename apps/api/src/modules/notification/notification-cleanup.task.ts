import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { runtime } from '../settings/runtime-config';
import { Notification } from './entities/notification.entity';

/**
 * 站内通知会一直累积（此前没有任何清理）。保留天数可配置
 * （设置 → 发布队列 → 通知保留天数，默认 90 天，填 0 表示永久保留）。
 */
@Injectable()
export class NotificationCleanupTask {
  private readonly logger = new Logger(NotificationCleanupTask.name);

  constructor(@InjectRepository(Notification) private readonly notifications: Repository<Notification>) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneOldNotifications(): Promise<{ removed: number }> {
    const days = runtime().publish.notificationRetentionDays;
    if (days <= 0) return { removed: 0 };

    const deadline = new Date(Date.now() - days * 86_400_000);
    try {
      const result = await this.notifications.delete({ createdAt: LessThan(deadline) });
      const removed = result.affected ?? 0;
      if (removed > 0) this.logger.log(`已清理 ${removed} 条超过 ${days} 天的通知`);
      return { removed };
    } catch (error) {
      this.logger.warn(`通知清理失败：${error instanceof Error ? error.message : String(error)}`);
      return { removed: 0 };
    }
  }
}
