import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpsMonitorService, MonitorRunResult } from './ops-monitor.service';

/**
 * 每分钟醒来一次，由配置的巡检间隔决定是否真正执行（默认 5 分钟）。
 * 用「唤醒 + 间隔判断」而不是动态 cron 表达式：表达式无法随运行时配置改变。
 */
@Injectable()
export class OpsMonitorTask {
  private readonly logger = new Logger(OpsMonitorTask.name);

  constructor(private readonly monitor: OpsMonitorService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<MonitorRunResult | null> {
    try {
      return await this.monitor.tick();
    } catch (error) {
      this.logger.warn(`运行监控巡检失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
