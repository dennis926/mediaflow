import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Content } from '../content/entities/content.entity';
import { SocialAccount } from '../platform/entities/social-account.entity';
import { PublishTask } from '../publish/entities/publish-task.entity';
import { PublishModule } from '../../publish/publish.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { Analytics } from './entities/analytics.entity';
import { TrackEvent } from './entities/track-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Analytics, TrackEvent, Content, PublishTask, SocialAccount]), PublishModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
