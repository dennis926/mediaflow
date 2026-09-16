import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { TokenStore } from '@mediaflow/channel-adapters';
import { REDIS_CLIENT } from '../redis/redis.constants';

/** Redis backed token cache shared by the platform adapters. */
@Injectable()
export class RedisTokenStore implements TokenStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', Math.max(ttlSeconds, 1));
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
