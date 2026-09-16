import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../modules/auth/public.decorator';

interface HealthPayload {
  status: 'ok';
  service: string;
  env: string;
  database: string;
  redis: string;
  timestamp: string;
}

/** Used by load balancers, deployment scripts and the smoke test suite. */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  check(): HealthPayload {
    return {
      status: 'ok',
      service: 'mediaflow-api',
      env: this.configService.get<string>('NODE_ENV') ?? 'development',
      database: 'postgres',
      redis: 'redis',
      timestamp: new Date().toISOString(),
    };
  }
}
