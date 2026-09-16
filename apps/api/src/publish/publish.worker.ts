import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelAdapterRegistry, PublishResult } from '@mediaflow/channel-adapters';
import { PublishTaskStatus } from '@mediaflow/shared';
import { AuditService } from '../audit/audit.service';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';
import { CHANNEL_REGISTRY } from './channel-registry.provider';
import { PublishQueueService } from './publish.queue';
import { PublishService } from './publish.service';

const SWEEP_INTERVAL_MS = 15_000;
const BLOCK_MS = 5_000;
const READ_COUNT = 5;
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
    private readonly config: ConfigService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelAdapterRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('发布 Worker 已禁用（PUBLISH_WORKER_ENABLED=false）');
      return;
    }
    await this.queue.ensureGroup();
    this.running = true;
    void this.consumeLoop();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.logger.log(`发布 Worker 已启动：消费者 ${this.consumerName}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private get enabled(): boolean {
    const value = this.config.get<string>('PUBLISH_WORKER_ENABLED');
    return value === undefined || value === '' ? true : value === 'true';
  }

  private async consumeLoop(): Promise<void> {
    await this.reclaimStale();
    while (this.running) {
      try {
        const entries = await this.queue.read(this.consumerName, READ_COUNT, BLOCK_MS);
        for (const entry of entries) {
          try {
            await this.handle(entry.taskId);
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
        await this.handle(entry.taskId);
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
