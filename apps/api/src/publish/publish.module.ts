import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiGeneration } from '../modules/ai/entities/ai-generation.entity';
import { ContentVariant } from '../modules/content/entities/content-variant.entity';
import { Content } from '../modules/content/entities/content.entity';
import { SocialAccount } from '../modules/platform/entities/social-account.entity';
import { PlatformModule } from '../modules/platform/platform.module';
import { SettingsModule } from '../modules/settings/settings.module';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';
import { ChannelModule } from './channel.module';
import { PublishController } from './publish.controller';
import { PublishQueueService } from './publish.queue';
import { PublishService } from './publish.service';
import { PublishWorker } from './publish.worker';

@Module({
  imports: [
    TypeOrmModule.forFeature([PublishTask, Content, ContentVariant, SocialAccount, AiGeneration]),
    ChannelModule,
    SettingsModule,
    PlatformModule,
  ],
  controllers: [PublishController],
  providers: [PublishService, PublishQueueService, PublishWorker],
  exports: [PublishService, PublishQueueService],
})
export class PublishModule {}
