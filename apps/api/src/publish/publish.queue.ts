import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { runtime } from '../modules/settings/runtime-config';

export const PUBLISH_STREAM = 'mediaflow:publish:tasks';
export const PUBLISH_GROUP = 'publish-workers';

/** 队列名与消费组名可配置（设置 → 发布队列），默认沿用内置名称。 */
export const streamName = (): string => runtime().publish.streamName;
export const groupName = (): string => runtime().publish.groupName;
/** 默认回收阈值；实际取值来自配置 PUBLISH_CLAIM_IDLE_MS。 */
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
export class PublishQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PublishQueueService.name);
  /** Reads block up to BLOCK_MS; on the shared connection that would stall every other Redis command. */
  private readonly reader: Redis;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    const duplicate = (this.redis as { duplicate?: () => Redis }).duplicate;
    this.reader = typeof duplicate === 'function' ? this.redis.duplicate() : this.redis;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reader === this.redis) return;
    try {
      await this.reader.quit();
    } catch {
      this.reader.disconnect();
    }
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', streamName(), groupName(), '$', 'MKSTREAM');
      this.logger.log(`已创建消费组 ${groupName()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  async enqueue(taskId: string): Promise<string> {
    const id = await this.redis.xadd(streamName(), '*', 'taskId', taskId, 'enqueuedAt', new Date().toISOString());
    return String(id);
  }

  async read(consumer: string, count: number, blockMs: number): Promise<StreamEntry[]> {
    const raw = await this.reader.xreadgroup('GROUP', groupName(), consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', streamName(), '>');
    return parseStreamEntries(raw);
  }

  /** Takes over entries whose consumer died before acknowledging them. */
  async claimStale(consumer: string, count = 20): Promise<StreamEntry[]> {
    const raw = await this.redis.xautoclaim(streamName(), groupName(), consumer, runtime().publish.claimIdleMs, '0-0', 'COUNT', count);
    if (!Array.isArray(raw)) return [];
    const claimed = raw[1];
    return parseStreamEntries([[streamName(), claimed]]);
  }

  /**
   * Drops consumers that left nothing pending, e.g. workers from previous restarts.
   * Without this the consumer list grows on every deploy.
   */
  async pruneIdleConsumers(keep: string): Promise<number> {
    // XINFO CONSUMERS needs the group name as well.
    const raw = await this.redis.call('XINFO', 'CONSUMERS', streamName(), groupName()).catch((error: unknown) => {
      this.logger.warn(`读取消费者列表失败：${error instanceof Error ? error.message : String(error)}`);
      return [] as unknown;
    });
    if (!Array.isArray(raw)) return 0;
    let removed = 0;
    for (const entry of raw) {
      if (!Array.isArray(entry)) continue;
      const info = new Map<string, string>();
      for (let index = 0; index + 1 < entry.length; index += 2) {
        info.set(String(entry[index]), String(entry[index + 1]));
      }
      const name = info.get('name');
      const pending = Number(info.get('pending') ?? '0');
      if (!name || name === keep || pending > 0) continue;
      await this.redis.call('XGROUP', 'DELCONSUMER', streamName(), groupName(), name);
      removed += 1;
    }
    return removed;
  }

  async ack(messageId: string): Promise<void> {
    await this.redis.xack(streamName(), groupName(), messageId);
  }

  async stats(): Promise<{ length: number; pending: number; consumers: number }> {
    const length = await this.redis.xlen(streamName());
    const groups = await this.redis.xinfo('GROUPS', streamName()).catch(() => [] as unknown[]);
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
