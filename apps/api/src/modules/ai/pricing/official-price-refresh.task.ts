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
 *
 * 连续失败会退避：有的站点（火山引擎）会对自动化访问做人机校验，一直重试只会把
 * 自己的出口 IP 拉黑得更久。失败次数越多、等得越久，最长退避 24 小时。
 */
@Injectable()
export class OfficialPriceRefreshTask {
  private readonly logger = new Logger(OfficialPriceRefreshTask.name);
  private lastRunAt = 0;
  /** 防止上一轮还没跑完就启动下一轮（多供应商串行抓取会超过一分钟）。 */
  private running = false;
  /** provider -> 连续失败次数；成功即清零。 */
  private readonly failures = new Map<string, number>();
  /** provider -> 退避截止时间戳；到点前不再请求该供应商。 */
  private readonly backoffUntil = new Map<string, number>();

  constructor(private readonly pricing: ModelPricingService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    try {
      const enabled = await this.pricing.officialRefreshEnabled();
      if (!enabled) return;

      const intervalMinutes = await this.pricing.officialRefreshIntervalMinutes();
      if (intervalMinutes <= 0) return;

      const now = Date.now();
      if (now - this.lastRunAt < intervalMinutes * 60_000) return;
      this.lastRunAt = now;

      this.running = true;

      // 真正跳过退避中的供应商。只把退避写进日志、请求照发，等于没有退避——
      // 火山引擎的人机校验就是被这样一轮轮打出来的（失败 4 次仍在每轮重试）。
      const now2 = Date.now();
      const skip = new Set(
        [...this.backoffUntil.entries()].filter(([, until]) => until > now2).map(([provider]) => provider),
      );
      if (skip.size) {
        this.logger.log(`退避中，本轮跳过：${[...skip].join('、')}`);
      }

      const { succeeded, failed } = await this.pricing.refreshAllOfficialPrices(skip);

      for (const result of succeeded) {
        this.failures.delete(result.provider);
        this.backoffUntil.delete(result.provider);
      }
      for (const failure of failed) {
        const count = (this.failures.get(failure.provider) ?? 0) + 1;
        this.failures.set(failure.provider, count);
        const backoff = this.backoffMinutes(count);
        if (backoff > 0) this.backoffUntil.set(failure.provider, Date.now() + backoff * 60_000);
        this.logger.warn(
          `抓取 ${failure.provider} 官方价格失败第 ${count} 次（保留上一份快照，${backoff} 分钟内不再重试）：${failure.message}`,
        );
      }

      if (succeeded.length) {
        this.logger.log(
          `官网价格已刷新：${succeeded.map((item) => `${item.provider}(${item.prices.length})`).join('、')}`,
        );
      }
    } catch (error) {
      this.logger.warn(`官方价格抓取任务异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * 连续失败 n 次后的退避时长（分钟）：2^n 递增，封顶 24 小时。
   * 第 1 次失败不额外退避（只按正常间隔），避免偶发网络抖动被当成封禁。
   */
  private backoffMinutes(consecutiveFailures: number): number {
    if (consecutiveFailures <= 1) return 0;
    const minutes = Math.min(2 ** (consecutiveFailures - 1), 24 * 60);
    return minutes;
  }

  /** 当前连续失败次数（供健康检查/监控读取）。 */
  failureCounts(): Record<string, number> {
    return Object.fromEntries(this.failures);
  }

  /** 当前处于退避中的供应商及剩余分钟数（供健康检查/监控读取）。 */
  backoffState(): Record<string, number> {
    const now = Date.now();
    return Object.fromEntries(
      [...this.backoffUntil.entries()]
        .filter(([, until]) => until > now)
        .map(([provider, until]) => [provider, Math.ceil((until - now) / 60_000)]),
    );
  }
}
