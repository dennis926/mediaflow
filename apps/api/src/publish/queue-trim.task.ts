import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { runtime } from '../modules/settings/runtime-config';
import { PublishQueueService } from './publish.queue';

/**
 * 发布队列的兜底修剪。
 *
 * 入队时已经带了 `MAXLEN ~`，正常情况下队列不会无限增长；这个每日任务处理两类遗留：
 * 1. 上限被调小之后，历史 stream 仍然偏长；
 * 2. 入队路径之外的写入（例如人工调试）留下的多余消息。
 *
 * 注意：Redis 的 `MAXLEN ~` 只裁剪最旧的条目，**不会**删除消费组 PEL 中未 ack 的消息，
 * 因此正在处理中的任务不受影响。
 */
@Injectable()
export class QueueTrimTask {
  private readonly logger = new Logger(QueueTrimTask.name);

  constructor(private readonly queue: PublishQueueService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async trimQueue(): Promise<{ removed: number; maxLen: number; floor: string | null }> {
    const maxLen = runtime().publish.maxLen;
    const { removed, floor } = await this.queue.trim();
    if (removed === 0) {
      this.logger.debug(`发布队列无需修剪（上限 ${maxLen}${floor ? `，保护未确认消息自 ${floor} 起` : ''}）`);
    }
    return { removed, maxLen, floor };
  }
}
