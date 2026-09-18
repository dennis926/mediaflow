import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditService } from '../audit/audit.service';
import { WorkspaceContextService } from '../common/workspace-context.service';
import { NotificationService } from '../modules/notification/notification.service';
import { runtime } from '../modules/settings/runtime-config';
import { PublishQueueService } from './publish.queue';

export interface QueueTrimResult {
  stream: string;
  maxLen: number;
  lengthBefore: number;
  lengthAfter: number;
  removed: number;
  /** 最早未确认消息 ID（有则修剪只做 MINID 保护，不按长度压缩） */
  floor: string | null;
  /** 是否触发了容量告警 */
  alerted: boolean;
  /** 是否达到严重阈值（额外写审计） */
  overflow: boolean;
}

/**
 * 发布队列的兜底修剪 + 容量告警。
 *
 * 入队时不做自动修剪（`MAXLEN` 会删掉未 ack 的消息，见 docs/RUNBOOK-队列修剪.md），
 * 因此队列长度收敛完全依赖本任务：每小时按 pending-aware 策略修剪一次。
 *
 * 告警阈值（相对配置上限 PUBLISH_STREAM_MAXLEN）：
 * - 超过 2 倍：站内/外部通知（告警文案含当前长度、上限、最早未确认 ID）；
 * - 超过 10 倍：额外写审计日志 `queue.trim.overflow`。
 * 修剪后仍超阈值通常意味着"有大量未确认消息卡住"（消费者挂了或任务一直失败），需要人工介入。
 */
@Injectable()
export class QueueTrimTask {
  private readonly logger = new Logger(QueueTrimTask.name);

  constructor(
    private readonly queue: PublishQueueService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly workspaceContext: WorkspaceContextService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async trimQueue(): Promise<QueueTrimResult> {
    const maxLen = runtime().publish.maxLen;
    const stream = runtime().publish.streamName;

    const lengthBefore = await this.queue.length();
    const floor = await this.queue.pendingFloor();
    const { removed } = await this.queue.trim();
    const lengthAfter = await this.queue.length();

    const warnThreshold = maxLen * 2;
    const overflowThreshold = maxLen * 10;
    let alerted = false;
    let overflow = false;

    if (lengthAfter > warnThreshold) {
      alerted = true;
      overflow = lengthAfter > overflowThreshold;
      const pendingNote = floor
        ? `最早未确认消息 ${floor}（有未确认消息时不按长度压缩，需检查消费者与失败任务）`
        : '无未确认消息（若仍超限请检查队列写入是否异常）';
      const body =
        `发布队列当前 ${lengthAfter} 条，上限 ${maxLen} 条（本次修剪删除 ${removed} 条）。` +
        `${pendingNote}。请到「发布队列 → 队列运维」查看卡死任务与死信。`;

      await this.notifications
        .notify({
          type: overflow ? 'queue.overflow.critical' : 'queue.overflow',
          level: overflow ? 'error' : 'warning',
          title: overflow ? `发布队列严重超限：${lengthAfter} 条` : `发布队列超过容量警戒：${lengthAfter} 条`,
          body,
          resourceType: 'publish_queue',
          // resource_id 在库里是 uuid 列：stream 名不是 uuid，放 payload（否则插入报 invalid input syntax for type uuid）
          resourceId: null,
          payload: { stream, lengthBefore, lengthAfter, maxLen, floor, removed },
          external: true,
        })
        .catch((error: unknown) => {
          this.logger.warn(`队列告警通知失败：${error instanceof Error ? error.message : String(error)}`);
        });
      this.logger.warn(body);
    }

    if (overflow) {
      // 后台任务没有请求作用域，用当前/默认工作区写审计
      const scope = await this.workspaceContext.current();
      await this.audit
        .record({
          action: 'queue.trim.overflow',
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          resourceType: 'publish_queue',
          resourceId: stream,
          payload: { stream, lengthBefore, lengthAfter, maxLen, floor, removed, threshold: overflowThreshold },
        })
        .catch(() => undefined);
    }

    if (removed === 0 && !alerted) {
      this.logger.debug(`发布队列无需修剪（${lengthAfter}/${maxLen}）`);
    }

    return { stream, maxLen, lengthBefore, lengthAfter, removed, floor, alerted, overflow };
  }
}
