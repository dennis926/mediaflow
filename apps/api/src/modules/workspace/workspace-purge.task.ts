import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WorkspacePurgeService } from './workspace-purge.service';

/**
 * 工作区到期清除与备份清理（B0.4 第 4 步）。
 *
 * - 每日 04:00：把"软删已满保留期"（`purge_after <= now()`）的工作区按 §7 流程永久清除；
 *   没有 owner 的工作区不会自动清除（记 WARN，等人工处理），避免无人可担责的删除。
 * - 每日 04:30：清理超过保留期（默认 180 天）的 purge 备份，删除前写审计。
 */
@Injectable()
export class WorkspacePurgeTask {
  private readonly logger = new Logger(WorkspacePurgeTask.name);

  constructor(private readonly purge: WorkspacePurgeService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeDueWorkspaces(): Promise<{ purged: number; failed: number }> {
    try {
      const result = await this.purge.purgeExpiredWorkspaces();
      if (result.purged > 0 || result.failed > 0) {
        this.logger.log(`到期工作区清除：成功 ${result.purged} 个，失败 ${result.failed} 个`);
      }
      return { purged: result.purged, failed: result.failed };
    } catch (error) {
      this.logger.warn(`到期工作区清除任务异常：${error instanceof Error ? error.message : String(error)}`);
      return { purged: 0, failed: 0 };
    }
  }

  @Cron('0 30 4 * * *')
  async pruneBackups(): Promise<{ removed: number; bytes: number }> {
    try {
      return await this.purge.pruneBackups();
    } catch (error) {
      this.logger.warn(`purge 备份清理失败：${error instanceof Error ? error.message : String(error)}`);
      return { removed: 0, bytes: 0 };
    }
  }
}
