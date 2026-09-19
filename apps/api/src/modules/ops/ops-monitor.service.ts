import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { PublishQueueService } from '../../publish/publish.queue';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { NotificationService } from '../notification/notification.service';
import { AiGeneration } from '../ai/entities/ai-generation.entity';
import { PublishTask } from '../publish/entities/publish-task.entity';
import { runtime } from '../settings/runtime-config';

export type MonitorCheckKey =
  | 'queue_length'
  | 'queue_pending_age'
  | 'publish_failure_rate'
  | 'login_failures'
  | 'upload_disk'
  | 'ai_token_quota';

export interface MonitorCheck {
  key: MonitorCheckKey;
  label: string;
  /** 当前观测值（数值化，便于前端/告警展示） */
  current: number;
  threshold: number;
  unit: string;
  triggered: boolean;
  level: 'warning' | 'error';
  /** 人话解释：当前值、阈值、是否命中、异常时的排查建议 */
  detail: string;
  /** 排查入口（站内页面直链） */
  link: string;
  checkedAt: string;
}

export interface MonitorRunResult {
  checks: MonitorCheck[];
  /** 本次实际发出的告警（受冷却时间约束） */
  emitted: MonitorCheckKey[];
  /** 命中阈值但处于冷却期、未重复告警的项 */
  suppressed: MonitorCheckKey[];
}

/**
 * 运行监控：把"出事之前能看出来"的六类信号变成可执行检查。
 *
 * 全部阈值来自设置（可在后台改、也可被测试通道覆盖），任何一项命中即写入站内通知，
 * error 级额外落审计。同类告警有冷却时间，避免刷屏。
 */
@Injectable()
export class OpsMonitorService {
  private readonly logger = new Logger(OpsMonitorService.name);
  private static readonly LAST_RUN_KEY = 'ops:monitor:last';

  constructor(
    private readonly queue: PublishQueueService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(PublishTask) private readonly tasks: Repository<PublishTask>,
    @InjectRepository(AiGeneration) private readonly generations: Repository<AiGeneration>,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  private now(): string {
    return new Date().toISOString();
  }

  /** 告警是给人看的：时间用北京时间，不用 ISO/UTC 原文。 */
  private humanTime(iso: string): string {
    return new Date(iso).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  private link(path: string): string {
    const base = runtime().monitor.opsBaseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private alertKey(key: MonitorCheckKey): string {
    return `ops:monitor:alerted:${key}`;
  }

  /** 1. 发布队列积压 */
  async checkQueueLength(): Promise<MonitorCheck> {
    const threshold = runtime().monitor.queueLengthThreshold;
    const current = await this.queue.length();
    return {
      key: 'queue_length',
      label: '发布队列积压',
      current,
      threshold,
      unit: '条',
      triggered: current > threshold,
      level: 'warning',
      detail:
        current > threshold
          ? `队列积压 ${current} 条（阈值 ${threshold} 条）：请检查发布 Worker 是否在消费、平台接口是否变慢。`
          : `队列 ${current} 条，未超过阈值 ${threshold} 条。`,
      link: this.link('/publish/queue'),
      checkedAt: this.now(),
    };
  }

  /** 2. 未确认消息滞留（消费者卡死/掉线的最直接信号） */
  async checkPendingAge(): Promise<MonitorCheck> {
    const thresholdSeconds = runtime().monitor.pendingAgeSeconds;
    const idleMs = await this.queue.oldestPendingIdleMs();
    const current = idleMs === null ? 0 : Math.round(idleMs / 1000);
    const triggered = idleMs !== null && current > thresholdSeconds;
    return {
      key: 'queue_pending_age',
      label: '未确认消息滞留',
      current,
      threshold: thresholdSeconds,
      unit: '秒',
      triggered,
      level: 'error',
      detail:
        idleMs === null
          ? '当前没有未确认消息。'
          : triggered
            ? `最早一条未确认消息已滞留 ${current} 秒（阈值 ${thresholdSeconds} 秒）：消费者可能已卡死或掉线，需人工确认队列运维页的卡死任务。`
            : `最早未确认消息滞留 ${current} 秒，未超过阈值 ${thresholdSeconds} 秒。`,
      link: this.link('/publish/queue'),
      checkedAt: this.now(),
    };
  }

  /** 3. 近 1 小时发布失败率 */
  async checkPublishFailureRate(): Promise<MonitorCheck> {
    const threshold = runtime().monitor.failureRatePercent;
    const minSample = runtime().monitor.failureMinSample;
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const row = await this.tasks
      .createQueryBuilder('task')
      .select("COUNT(*) FILTER (WHERE task.status = 'failed')", 'failed')
      .addSelect('COUNT(*)', 'total')
      .where('task.finishedAt >= :since', { since })
      .getRawOne<{ failed: string; total: string }>();
    const total = Number(row?.total ?? 0);
    const failed = Number(row?.failed ?? 0);
    const rate = total === 0 ? 0 : Math.round((failed / total) * 1000) / 10;
    const enough = total >= minSample;
    return {
      key: 'publish_failure_rate',
      label: '发布失败率',
      current: rate,
      threshold,
      unit: '%',
      triggered: enough && rate > threshold,
      level: 'warning',
      detail: !enough
        ? `近 1 小时发布任务 ${total} 条（样本少于 ${minSample} 条，不做失败率判定）。`
        : rate > threshold
          ? `近 1 小时 ${total} 条任务中失败 ${failed} 条，失败率 ${rate}%（阈值 ${threshold}%）：请检查平台凭证是否过期、内容是否被平台拒审。`
          : `近 1 小时 ${total} 条任务，失败率 ${rate}%，未超过阈值 ${threshold}%。`,
      link: this.link('/publish/queue'),
      checkedAt: this.now(),
    };
  }

  /** 4. 登录失败激增（爆破/撞库的最早信号） */
  async checkLoginFailures(): Promise<MonitorCheck> {
    const threshold = runtime().monitor.loginFailThreshold;
    const windowMinutes = runtime().monitor.loginFailWindowMinutes;
    const raw = await this.redis.get('auth:fail:window').catch(() => null);
    const current = Number(raw ?? 0);
    return {
      key: 'login_failures',
      label: '登录失败次数',
      current,
      threshold,
      unit: '次',
      triggered: current > threshold,
      level: 'error',
      detail:
        current > threshold
          ? `${windowMinutes} 分钟窗口内登录失败 ${current} 次（阈值 ${threshold} 次）：疑似爆破/撞库，请确认是否封禁来源 IP 或临时锁定账号。`
          : `${windowMinutes} 分钟窗口内登录失败 ${current} 次，未超过阈值 ${threshold} 次。`,
      link: this.link('/users'),
      checkedAt: this.now(),
    };
  }

  /** 5. 素材磁盘使用率 */
  async checkUploadDisk(): Promise<MonitorCheck> {
    const threshold = runtime().monitor.diskUsedPercent;
    const dir = this.resolveStorageDir();
    let current = 0;
    let detail: string;
    try {
      const stats = statfsSync(dir);
      /**
       * 与 `df` 保持一致的口径：
       * - 已用 = blocks - bfree
       * - 分母 = 已用 + bavail（bavail **不含** root 保留块，bfree 含）
       * 早期版本用 (blocks-bfree)/blocks，会低估几个百分点（实测 46.7% vs df 51.2%），
       * 导致监控数字和运维在命令行看到的对不上。
       */
      const usedBlocks = stats.blocks - stats.bfree;
      const totalBlocks = usedBlocks + stats.bavail;
      current = totalBlocks === 0 ? 0 : Math.round((usedBlocks / totalBlocks) * 1000) / 10;
      detail =
        current > threshold
          ? `素材目录所在磁盘已用 ${current}%（阈值 ${threshold}%）：请清理历史素材或扩容，写满会导致上传与发布全部失败。`
          : `素材目录所在磁盘已用 ${current}%，未超过阈值 ${threshold}%。`;
    } catch (error) {
      detail = `无法读取磁盘用量（${error instanceof Error ? error.message : String(error)}）。`;
    }
    return {
      key: 'upload_disk',
      label: '上传磁盘使用率',
      current,
      threshold,
      unit: '%',
      triggered: current > threshold,
      level: 'warning',
      detail,
      link: this.link('/media'),
      checkedAt: this.now(),
    };
  }

  /** 6. AI 当日 token 消耗占日配额比例 */
  async checkAiQuota(): Promise<MonitorCheck> {
    const quota = runtime().ai.dailyTokenQuota;
    const threshold = runtime().monitor.aiQuotaPercent;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const row = await this.generations
      .createQueryBuilder('generation')
      .select(
        'COALESCE(SUM(COALESCE(generation.tokensInput, 0) + COALESCE(generation.tokensOutput, 0) + ' +
          'COALESCE(generation.tokensCached, 0) + COALESCE(generation.tokensCacheWrite, 0) + ' +
          'COALESCE(generation.tokensReasoning, 0)), 0)',
        'tokens',
      )
      .where('generation.createdAt >= :start', { start })
      .getRawOne<{ tokens: string }>();
    const used = Number(row?.tokens ?? 0);
    if (quota <= 0) {
      return {
        key: 'ai_token_quota',
        label: 'AI 日配额消耗',
        current: used,
        threshold: 0,
        unit: 'token',
        triggered: false,
        level: 'warning',
        detail: `未配置 AI 日配额（AI_DAILY_TOKEN_QUOTA=0），今日已用 ${used} token，跳过告警。`,
        link: this.link('/ai-usage'),
        checkedAt: this.now(),
      };
    }
    const percent = Math.round((used / quota) * 1000) / 10;
    return {
      key: 'ai_token_quota',
      label: 'AI 日配额消耗',
      current: percent,
      threshold,
      unit: '%',
      triggered: percent > threshold,
      level: 'warning',
      detail:
        percent > threshold
          ? `今日已用 ${used} / ${quota} token（${percent}%，阈值 ${threshold}%）：接近配额上限，可考虑降级模型或减少批量生成。`
          : `今日已用 ${used} / ${quota} token（${percent}%），未超过阈值 ${threshold}%。`,
      link: this.link('/ai-usage'),
      checkedAt: this.now(),
    };
  }

  /** 跑全部检查；emit=false 只观察不告警（用于后台预演与测试断言）。 */
  async runAll(options: { emit?: boolean } = {}): Promise<MonitorRunResult> {
    const runners: Array<() => Promise<MonitorCheck>> = [
      () => this.checkQueueLength(),
      () => this.checkPendingAge(),
      () => this.checkPublishFailureRate(),
      () => this.checkLoginFailures(),
      () => this.checkUploadDisk(),
      () => this.checkAiQuota(),
    ];
    const checks: MonitorCheck[] = [];
    for (const runner of runners) {
      try {
        checks.push(await runner());
      } catch (error) {
        this.logger.warn(`监控检查失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const emitted: MonitorCheckKey[] = [];
    const suppressed: MonitorCheckKey[] = [];
    if (options.emit !== false) {
      for (const check of checks.filter((item) => item.triggered)) {
        const allowed = await this.acquireAlertSlot(check.key);
        if (!allowed) {
          suppressed.push(check.key);
          continue;
        }
        await this.emitAlert(check);
        emitted.push(check.key);
      }
    }
    return { checks, emitted, suppressed };
  }

  /** 冷却闸门：同类告警在冷却期内只发一次。 */
  private async acquireAlertSlot(key: MonitorCheckKey): Promise<boolean> {
    const ttl = Math.max(60, runtime().monitor.alertCooldownMinutes * 60);
    try {
      const result = await this.redis.set(this.alertKey(key), '1', 'EX', ttl, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.warn(`告警冷却检查失败（按可发处理）：${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }

  private async emitAlert(check: MonitorCheck): Promise<void> {
    // 告警文案必须自带四要素：当前值、阈值、时间、排查入口
    const body =
      `当前值：${check.current}${check.unit}；阈值：${check.threshold}${check.unit}；` +
      `检查时间：${this.humanTime(check.checkedAt)}；排查入口：${check.link}。${check.detail}`;
    try {
      await this.notifications.notify({
        type: `ops.monitor.${check.key}`,
        level: check.level,
        title: `[监控] ${check.label}异常：${check.current}${check.unit}（阈值 ${check.threshold}${check.unit}）`,
        body,
        resourceType: 'ops_monitor',
        // resource_id 是 uuid 列：检查项 key 不是 uuid，放 payload
        resourceId: null,
        payload: {
          key: check.key,
          current: check.current,
          threshold: check.threshold,
          unit: check.unit,
          checkedAt: check.checkedAt,
          link: check.link,
        },
        external: true,
      });
    } catch (error) {
      this.logger.warn(`监控告警通知失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (check.level === 'error') {
      // 定时任务没有请求作用域：用当前/默认工作区写审计
      const scope = await this.workspaceContext
        .current()
        .catch(() => null);
      if (scope) {
        await this.audit
          .record({
            action: 'ops.alert',
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            resourceType: 'ops_monitor',
            resourceId: null,
            payload: { key: check.key, current: check.current, threshold: check.threshold, link: check.link },
          })
          .catch(() => undefined);
      }
    }
  }

  /**
   * 定时巡检入口：按配置的间隔执行（定时器每分钟醒来一次，未到间隔直接跳过）。
   * 返回 null 表示本次未执行。
   */
  async tick(): Promise<MonitorRunResult | null> {
    if (!runtime().monitor.enabled) return null;
    const intervalMs = runtime().monitor.intervalSeconds * 1000;
    const last = Number((await this.redis.get(OpsMonitorService.LAST_RUN_KEY).catch(() => null)) ?? 0);
    if (last && Date.now() - last < intervalMs) return null;
    await this.redis.set(OpsMonitorService.LAST_RUN_KEY, String(Date.now())).catch(() => undefined);

    const result = await this.runAll();
    if (result.emitted.length > 0) {
      this.logger.warn(`运行监控命中 ${result.emitted.length} 项并已告警：${result.emitted.join(', ')}`);
    }
    return result;
  }

  private resolveStorageDir(): string {
    const configured = runtime().media.storageDir;
    return configured.startsWith('/') ? configured : join(process.cwd(), '../..', configured);
  }
}
