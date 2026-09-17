import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { Inject } from '@nestjs/common';
import { Public } from '../modules/auth/public.decorator';
import { REDIS_CLIENT } from '../redis/redis.constants';

interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

interface HealthPayload {
  status: 'ok' | 'degraded';
  service: string;
  env: string;
  database: DependencyStatus;
  redis: DependencyStatus;
  timestamp: string;
}

/** 真实探活（数据库/Redis 都 ping 一次），供负载均衡与监控使用。 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<HealthPayload> {
    const [database, redis] = await Promise.all([this.probeDatabase(), this.probeRedis()]);
    const healthy = database.status === 'up' && redis.status === 'up';

    const payload: HealthPayload = {
      status: healthy ? 'ok' : 'degraded',
      service: 'mediaflow-api',
      env: this.configService.get<string>('NODE_ENV') ?? 'development',
      database,
      redis,
      timestamp: new Date().toISOString(),
    };

    if (!healthy) throw new ServiceUnavailableException(payload);
    return payload;
  }

  private async probeDatabase(): Promise<DependencyStatus> {
    const startedAt = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async probeRedis(): Promise<DependencyStatus> {
    const startedAt = Date.now();
    try {
      await this.redis.ping();
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
