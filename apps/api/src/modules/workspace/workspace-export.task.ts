import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WorkspaceExportService } from './workspace-export.service';

/**
 * 导出产物清理（B0.4 第 3 步）：产物 7 天后自动清理，清理前写审计
 * `workspace.export.expired`（由服务实现），因此定时任务只负责按天触发。
 */
@Injectable()
export class WorkspaceExportCleanupTask {
  private readonly logger = new Logger(WorkspaceExportCleanupTask.name);

  constructor(private readonly exports: WorkspaceExportService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async prune(): Promise<{ removed: number; bytes: number }> {
    try {
      return await this.exports.pruneExpired();
    } catch (error) {
      this.logger.warn(`导出产物清理失败：${error instanceof Error ? error.message : String(error)}`);
      return { removed: 0, bytes: 0 };
    }
  }
}
