import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
import { AiModule } from './modules/ai/ai.module';
import { ContentModule } from './modules/content/content.module';
import { buildNestDataSourceOptions } from './database/database.config';
import { HealthController } from './health/health.controller';
import { PublishModule } from './publish/publish.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildNestDataSourceOptions,
    }),
    RedisModule,
    CommonModule,
    AuditModule,
    PublishModule,
    AiModule,
    ContentModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
