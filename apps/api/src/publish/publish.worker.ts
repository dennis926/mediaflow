import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry, PublishResult } from '@mediaflow/channel-adapters';
import { PublishTaskStatus } from '@mediaflow/shared';
import { AuditService } from '../audit/audit.service';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';
import { CHANNEL_REGISTRY } from './channel-registry.provider';
import { runInWorkspaceScope } from '../common/workspace-context.store';
import { runtime } from '../modules/settings/runtime-config';
import { PublishQueueService } from './publish.queue';
import { PublishService } from './publish.service';
import { NotificationService } from '../modules/notification/notification.service';

const SWEEP_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES: PublishTaskStatus[] = [
  PublishTaskStatus.Published,
  PublishTaskStatus.ManualRequired,
  PublishTaskStatus.Failed,
  PublishTaskStatus.Canceled,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redis Stream consumer that executes publish tasks.
 *
 * The database stays the source of truth: every message only carries a task id, the worker
 * re-reads the row, claims it with a conditional update and then walks the status machine
 * (pending → scheduled → publishing → published / failed / manual_required).
 */
@Injectable()
export class PublishWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublishWorker.name);
  private readonly consumerName = `worker-${process.pid}`;
  private running = false;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly publishService: PublishService,
    private readonly queue: PublishQueueService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!(await this.enabled())) {
      this.logger.log('发布 Worker 已禁用（配置项 PUBLISH_WORKER_ENABLED=false）');
      return;
    }
    await this.queue.ensureGroup();
    const pruned = await this.queue.pruneIdleConsumers(this.consumerName).catch(() => 0);
    if (pruned > 0) this.logger.log(`已清理 ${pruned} 个空闲消费者记录`);
    this.running = true;
    void this.consumeLoop();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.logger.log(`发布 Worker 已启动：消费者 ${this.consumerName}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async enabled(): Promise<boolean> {
    /**
     * **部署层硬闸门**（B0.8 容器化实测踩到）：
     * 容器化后 api 与 worker 是两个容器，靠 `PUBLISH_WORKER_ENABLED=false/true` 区分，
     * 但该键在数据库里是"可配置项"——当数据库还没初始化（或配置读取失败）时，
     * 运行时快照会退回**代码默认值 true**，于是 api 容器也起了消费者 → **两个消费者抢同一条队列**。
     * 因此这里把环境变量当作硬开关：部署层关掉就绝不启动，数据库只能再关一次、不能再打开。
     */
    if ((process.env.PUBLISH_WORKER_ENABLED ?? '').trim().toLowerCase() === 'false') {
      return false;
    }
    return runtime().publish.workerEnabled;
  }

  private async consumeLoop(): Promise<void> {
    await this.reclaimStale();
    while (this.running) {
      try {
        const entries = await this.queue.read(this.consumerName, runtime().publish.readCount, runtime().publish.readBlockMs);
        for (const entry of entries) {
          try {
            await this.withTaskScope(entry.taskId);
          } finally {
            await this.queue.ack(entry.id);
          }
        }
      } catch (error) {
        if (!this.running) break;
        this.logger.error(`消费发布队列失败：${error instanceof Error ? error.message : String(error)}`);
        await sleep(1_000);
      }
    }
  }

  private async reclaimStale(): Promise<void> {
    try {
      const stale = await this.queue.claimStale(this.consumerName);
      for (const entry of stale) {
        if (entry.id === '0-0') continue;
        await this.withTaskScope(entry.taskId);
        await this.queue.ack(entry.id);
      }
      if (stale.length > 0) this.logger.log(`已接管 ${stale.length} 个中断的发布任务`);
    } catch (error) {
      this.logger.warn(`接管中断任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Re-enqueues due scheduled tasks and pending tasks that were dropped by Redis. */
  private async sweep(): Promise<void> {
    try {
      const due = await this.publishService.findDueTasks();
      for (const task of due) {
        if (task.status === PublishTaskStatus.Scheduled) await this.publishService.markScheduled(task);
        await this.publishService.enqueue(task.id);
      }
    } catch (error) {
      this.logger.warn(`扫描待发布任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 后台任务没有请求上下文：先读出任务所属工作区，再在该作用域里处理，
   * 否则多工作区场景会把任务写进默认工作区（历史缺陷）。
   */
  private async withTaskScope(taskId: string): Promise<void> {
    const scope = await this.publishService.scopeOf(taskId);
    if (!scope) {
      this.logger.warn(`任务 ${taskId} 不存在或已被删除，跳过`);
      return;
    }
    await runInWorkspaceScope(scope, () => this.handle(taskId));
  }

  private async handle(taskId: string): Promise<void> {
    const task = await this.load(taskId);
    if (!task) return;
    if (TERMINAL_STATUSES.includes(task.status)) {
      this.logger.debug(`任务 ${taskId} 已是终态（${task.status}），跳过`);
      return;
    }
    if (task.scheduledAt && task.scheduledAt.getTime() > Date.now()) {
      await this.publishService.markScheduled(task);
      return;
    }

    const claimed = await this.publishService.claim(taskId, this.consumerName);
    if (!claimed) {
      this.logger.debug(`任务 ${taskId} 已被其它 Worker 领取或状态已变更，跳过`);
      return;
    }

    const claimedTask = await this.load(taskId);
    if (!claimedTask) return;

    let result: PublishResult;
    try {
      result = await this.execute(claimedTask);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.publishService.releaseWithRetry(claimedTask, message);
      await this.record(claimedTask, 'publish_task.attempt_failed', { attempts: claimedTask.attempts, error: message });
      this.logger.warn(`任务 ${taskId} 执行异常（第 ${claimedTask.attempts} 次）：${message}`);

      // 用尽重试次数才算"彻底失败"：这时才提醒人（是否推送到群/邮件走配置）
      if (claimedTask.attempts >= claimedTask.maxAttempts && runtime().notify.onPublishFailure) {
        await this.notifications.notify({
          type: 'publish.failed',
          level: 'error',
          title: `发布失败：${claimedTask.platform}`,
          body: `任务重试 ${claimedTask.attempts} 次仍失败：${message}。请到「发布队列」查看详情并检查账号授权或内容格式。`,
          resourceType: 'publish_task',
          resourceId: claimedTask.id,
          payload: { platform: claimedTask.platform, attempts: claimedTask.attempts },
        });
      }
      return;
    }

    await this.applyResult(claimedTask, result);
  }

  private async execute(task: PublishTask): Promise<PublishResult> {
    const adapter = this.registry.get(task.platform);
    const payload = await this.publishService.buildPayload(task);
    const credentials = await this.publishService.resolveCredentials(task.platform, task.socialAccountId);
    return adapter.publish(payload, credentials);
  }

  private async applyResult(task: PublishTask, result: PublishResult): Promise<void> {
    switch (result.status) {
      case 'published':
        await this.publishService.completePublished(task, result);
        await this.record(task, 'publish_task.published', { platformPostId: result.platformPostId });
        this.logger.log(`任务 ${task.id} 发布成功（${task.platform}）`);
        return;
      case 'manual_required':
        await this.publishService.markManualRequired(task, result);
        await this.record(task, 'publish_task.manual_required', { message: result.message });
        await this.notifications.notify({
          type: 'publish.manual_required',
          level: 'warning',
          title: `待人工发布：${task.platform}`,
          body: result.message,
          resourceType: 'publish_task',
          resourceId: task.id,
          payload: { platform: task.platform },
        });
        this.logger.log(`任务 ${task.id} 需人工发布（${task.platform}）：${result.message}`);
        return;
      case 'pending':
        await this.publishService.markAwaitingHuman(task, result);
        await this.record(task, 'publish_task.awaiting_human', { message: result.message });
        this.logger.log(`任务 ${task.id} 等待人工确认（${task.platform}）：${result.message}`);
        return;
      default:
        await this.publishService.releaseWithRetry(task, result.message);
        await this.record(task, 'publish_task.attempt_failed', { attempts: task.attempts, error: result.message });
        this.logger.warn(`任务 ${task.id} 第 ${task.attempts} 次尝试失败：${result.message}`);
        if (task.attempts >= task.maxAttempts) {
          await this.notifications.notify({
            type: 'publish.failed',
            level: 'error',
            title: `发布失败（已重试 ${task.attempts} 次）：${task.platform}`,
            body: result.message,
            resourceType: 'publish_task',
            resourceId: task.id,
            payload: { platform: task.platform, attempts: task.attempts },
            external: true,
          });
        }
    }
  }

  private async load(taskId: string): Promise<PublishTask | null> {
    try {
      return await this.publishService.get(taskId);
    } catch {
      this.logger.warn(`任务 ${taskId} 不存在，忽略队列消息`);
      return null;
    }
  }

  private async record(task: PublishTask, action: string, payload: Record<string, unknown>): Promise<void> {
    await this.audit.record({
      action,
      resourceType: 'publish_task',
      resourceId: task.id,
      tenantId: task.tenantId,
      workspaceId: task.workspaceId,
      actorName: this.consumerName,
      payload: { platform: task.platform, status: task.status, ...payload },
    });
  }
}
