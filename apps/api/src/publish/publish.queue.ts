import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

export const PUBLISH_STREAM = 'mediaflow:publish:tasks';
export const PUBLISH_GROUP = 'publish-workers';
/** A worker that dies mid-flight leaves entries pending; they are re-claimed after this idle time. */
export const CLAIM_IDLE_MS = 60_000;

export interface StreamEntry {
  id: string;
  taskId: string;
}

function parseStreamEntries(raw: unknown): StreamEntry[] {
  const entries: StreamEntry[] = [];
  if (!Array.isArray(raw)) return entries;
  for (const streamChunk of raw) {
    if (!Array.isArray(streamChunk) || streamChunk.length < 2) continue;
    const messages = streamChunk[1];
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (!Array.isArray(message) || message.length < 2) continue;
      const [id, fields] = message as [unknown, unknown];
      if (!Array.isArray(fields)) continue;
      const map = new Map<string, string>();
      for (let index = 0; index + 1 < fields.length; index += 2) {
        map.set(String(fields[index]), String(fields[index + 1]));
      }
      const taskId = map.get('taskId');
      if (taskId) entries.push({ id: String(id), taskId });
    }
  }
  return entries;
}

@Injectable()
export class PublishQueueService {
  private readonly logger = new Logger(PublishQueueService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', PUBLISH_STREAM, PUBLISH_GROUP, '$', 'MKSTREAM');
      this.logger.log(`已创建消费组 ${PUBLISH_GROUP}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  async enqueue(taskId: string): Promise<string> {
    const id = await this.redis.xadd(PUBLISH_STREAM, '*', 'taskId', taskId, 'enqueuedAt', new Date().toISOString());
    return String(id);
  }

  async read(consumer: string, count: number, blockMs: number): Promise<StreamEntry[]> {
    const raw = await this.redis.xreadgroup('GROUP', PUBLISH_GROUP, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', PUBLISH_STREAM, '>');
    return parseStreamEntries(raw);
  }

  /** Takes over entries whose consumer died before acknowledging them. */
  async claimStale(consumer: string, count = 20): Promise<StreamEntry[]> {
    const raw = await this.redis.xautoclaim(PUBLISH_STREAM, PUBLISH_GROUP, consumer, CLAIM_IDLE_MS, '0-0', 'COUNT', count);
    if (!Array.isArray(raw)) return [];
    const claimed = raw[1];
    return parseStreamEntries([[PUBLISH_STREAM, claimed]]);
  }

  async ack(messageId: string): Promise<void> {
    await this.redis.xack(PUBLISH_STREAM, PUBLISH_GROUP, messageId);
  }

  async stats(): Promise<{ length: number; pending: number; consumers: number }> {
    const length = await this.redis.xlen(PUBLISH_STREAM);
    const groups = await this.redis.xinfo('GROUPS', PUBLISH_STREAM).catch(() => [] as unknown[]);
    const first = Array.isArray(groups) && groups.length > 0 ? groups[0] : null;
    let pending = 0;
    let consumers = 0;
    if (Array.isArray(first)) {
      for (let index = 0; index + 1 < first.length; index += 2) {
        if (String(first[index]) === 'pending') pending = Number(first[index + 1]);
        if (String(first[index]) === 'consumers') consumers = Number(first[index + 1]);
      }
    }
    return { length, pending, consumers };
  }
}
