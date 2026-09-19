import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublishModule } from '../../publish/publish.module';
import { NotificationModule } from '../notification/notification.module';
import { AiGeneration } from '../ai/entities/ai-generation.entity';
import { PublishTask } from '../publish/entities/publish-task.entity';
import { OpsController } from './ops.controller';
import { OpsMonitorService } from './ops-monitor.service';
import { OpsMonitorTask } from './ops-monitor.task';

@Module({
  imports: [TypeOrmModule.forFeature([PublishTask, AiGeneration]), PublishModule, NotificationModule],
  controllers: [OpsController],
  providers: [OpsMonitorService, OpsMonitorTask],
  exports: [OpsMonitorService],
})
export class OpsModule {}
