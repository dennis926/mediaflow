import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface HealthPayload {
  status: 'ok';
  service: string;
  env: string;
  timestamp: string;
}

/** Used by load balancers, deployment scripts and the smoke test suite. */
@Controller('health')
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  check(): HealthPayload {
    return {
      status: 'ok',
      service: 'mediaflow-api',
      env: this.configService.get<string>('NODE_ENV') ?? 'development',
      timestamp: new Date().toISOString(),
    };
  }
}
