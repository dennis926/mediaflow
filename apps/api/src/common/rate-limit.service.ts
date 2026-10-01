import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

/**
 * 固定窗口计数器限流。
 *
 * 为什么自己写而不是装 @nestjs/throttler：这个项目在阶段 B0 已经定下"依赖升级必须先过
 * 可达性评估、跨大版本必须实测真实路径"的规矩，而本项目只需要一个很窄的能力——
 * 给未登录也能打的接口按来源 IP 计数，超限返回 429。throttler 依赖 express-rate-limit
 * 与 ip 解析链，对一个内部工具来说收益不抵新增攻击面；这里用现成的 Redis 实现，
 * 计数原子（INCR + EXPIRE），多实例/多进程天然共享同一份计数。
 *
 * 语义：
 * - 固定窗口（非滑动窗口）：窗口边界处最坏情况允许 2 倍流量，对"防爆破/防刷"够用；
 * - Redis 不可用时**放行**（fail-open）：限流是加固手段，不能因为 Redis 抖动把登录一起打死。
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * 计数一次；返回 true 表示放行，false 表示超限。
   * @param bucket 计数桶（如 login / public-media），不同接口互不影响
   * @param identity 身份键（来源 IP，或 IP+账号）
   * @param limit 窗口内允许次数；<=0 表示不限制
   * @param windowSeconds 窗口秒数
   */
  async hit(bucket: string, identity: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; count: number }> {
    if (limit <= 0) return { allowed: true, count: 0 };
    const key = `ratelimit:${bucket}:${identity}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, windowSeconds);
      return { allowed: count <= limit, count };
    } catch (error) {
      this.logger.warn(`限流计数失败，本次放行：${error instanceof Error ? error.message : String(error)}`);
      return { allowed: true, count: 0 };
    }
  }

  /** 超限时抛出统一的 429（响应体沿用全局 { code, message, data } 信封）。 */
  assertAllowed(result: { allowed: boolean; count: number }, limit: number, windowSeconds: number, action: string): void {
    if (result.allowed) return;
    const minutes = Math.max(1, Math.round(windowSeconds / 60));
    throw new HttpException(
      `${action}过于频繁：每 ${minutes} 分钟最多 ${limit} 次，请稍后再试`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
