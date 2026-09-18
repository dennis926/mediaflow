import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationCleanupTask } from './notification-cleanup.task';
import { NotificationController } from './notification.controller';
import { NotificationChannelService } from './notification-channel.service';
import { NotificationService } from './notification.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationCleanupTask, NotificationChannelService],
  exports: [NotificationService, NotificationChannelService],
})
export class NotificationModule {}
