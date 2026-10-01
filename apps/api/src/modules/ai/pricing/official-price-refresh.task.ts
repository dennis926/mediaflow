import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ModelPricingService } from '../model-pricing.service';

/**
 * 定时抓取供应商官网价格。
 *
 * 用「每分钟醒来 + 间隔判断」而不是固定 cron 表达式：抓取间隔要能随运行时配置改变，
 * 而 cron 表达式在进程启动后就固定了（与 OpsMonitorTask 同一套路）。
 *
 * 抓取失败**绝不影响计费**：失败时保留上一份快照，只是日志告警。
 * 计费永远有可用价格（官网快照 → 预置目录 → 全局兜底），不会因为对方网站挂了而算不出钱。
 */
@Injectable()
export class OfficialPriceRefreshTask {
  private readonly logger = new Logger(OfficialPriceRefreshTask.name);
  private lastRunAt = 0;

  constructor(private readonly pricing: ModelPricingService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    try {
      const enabled = await this.pricing.officialRefreshEnabled();
      if (!enabled) return;

      const intervalMinutes = await this.pricing.officialRefreshIntervalMinutes();
      if (intervalMinutes <= 0) return;

      const now = Date.now();
      if (now - this.lastRunAt < intervalMinutes * 60_000) return;
      this.lastRunAt = now;

      for (const provider of await this.pricing.scrapableProviders()) {
        try {
          await this.pricing.refreshOfficialPrices(provider);
        } catch (error) {
          this.logger.warn(
            `抓取 ${provider} 官方价格失败（保留上一份快照）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`官方价格抓取任务异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
