import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { runtime } from '../settings/runtime-config';

/**
 * 上传并发限制（Redis 计数器）。
 *
 * 为什么需要：单机 8G 内存，磁盘暂存虽然避免了内存爆掉，但并发上传仍会同时占带宽、inode 与临时空间；
 * 内部 10 人场景下限制每人 3 个并发足够，对外 SaaS 时可调。
 *
 * key: `upload:concurrent:{userId}`，TTL 60 秒（即使进程被杀，计数也会自动过期，不会永久锁死用户）。
 */
@Injectable()
export class MediaUploadLimiter {
  private readonly logger = new Logger(MediaUploadLimiter.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(userId: string): string {
    return `upload:concurrent:${userId}`;
  }

  /**
   * 占用一个并发额度；超过上限抛 429（文案含当前值与上限）。
   * Redis 不可用时降级为放行（上传本身仍受大小/类型校验约束），避免因缓存故障导致业务不可用。
   */
  async acquire(userId: string): Promise<void> {
    const limit = runtime().media.maxConcurrentUploads;
    const ttl = runtime().media.uploadLockTtlSeconds;
    if (limit <= 0) return;

    try {
      const key = this.key(userId);
      const current = await this.redis.incr(key);
      if (current === 1) await this.redis.expire(key, ttl);
      if (current > limit) {
        // 超限时立刻归还这一次的计数，避免把后续请求也一起挡住
        await this.redis.decr(key);
        throw new HttpException(
          `同时上传的文件过多（当前 ${current - 1} 个，上限 ${limit} 个），请等待已有上传完成后再试`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`上传并发计数不可用，已放行：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 释放额度（必须放在 finally 中，否则计数泄漏会让用户被永久限流）。 */
  async release(userId: string): Promise<void> {
    const limit = runtime().media.maxConcurrentUploads;
    if (limit <= 0) return;
    try {
      const key = this.key(userId);
      const left = await this.redis.decr(key);
      if (left <= 0) await this.redis.del(key);
    } catch (error) {
      this.logger.warn(`释放上传并发计数失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 当前并发数（可观测用）。 */
  async current(userId: string): Promise<number> {
    try {
      const value = await this.redis.get(this.key(userId));
      return Number(value ?? 0);
    } catch {
      return 0;
    }
  }
}
