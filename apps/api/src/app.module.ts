import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { RolesGuard } from './modules/auth/roles.guard';
import { CapabilityGuard } from './modules/auth/capability.guard';
import { WorkspaceScopeInterceptor } from './common/workspace-scope.interceptor';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationModule } from './modules/notification/notification.module';
import { PlatformModule } from './modules/platform/platform.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { OpsModule } from './modules/ops/ops.module';
import { SettingsModule } from './modules/settings/settings.module';
import { CommonModule } from './common/common.module';
import { AiModule } from './modules/ai/ai.module';
import { ContentModule } from './modules/content/content.module';
import { buildNestDataSourceOptions } from './database/database.config';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { ChannelModule } from './publish/channel.module';
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
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    CommonModule,
    AuditModule,
    ChannelModule,
    PublishModule,
    AiModule,
    ContentModule,
    AuthModule,
    SettingsModule,
    MediaModule,
    NotificationModule,
    AnalyticsModule,
    PlatformModule,
    WorkspaceModule,
    OpsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_INTERCEPTOR, useClass: WorkspaceScopeInterceptor },
  ],
})
export class AppModule {}
