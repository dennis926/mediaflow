import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentVariant } from '../modules/content/entities/content-variant.entity';
import { Content } from '../modules/content/entities/content.entity';
import { SocialAccount } from '../modules/platform/entities/social-account.entity';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';
import { channelRegistryProvider } from './channel-registry.provider';
import { SettingsModule } from '../modules/settings/settings.module';
import { PublishController } from './publish.controller';
import { PublishQueueService } from './publish.queue';
import { PublishService } from './publish.service';
import { PublishWorker } from './publish.worker';
import { RedisTokenStore } from './token-store.service';

@Module({
  imports: [TypeOrmModule.forFeature([PublishTask, Content, ContentVariant, SocialAccount]), SettingsModule],
  controllers: [PublishController],
  providers: [PublishService, PublishQueueService, PublishWorker, RedisTokenStore, channelRegistryProvider],
  exports: [PublishService, PublishQueueService],
})
export class PublishModule {}
