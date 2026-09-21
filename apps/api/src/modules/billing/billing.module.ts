import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAsset } from '../media/entities/media-asset.entity';
import { WorkspaceMember } from '../workspace/entities/workspace-member.entity';
import { BillingController } from './billing.controller';
import { Invoice } from './entities/invoice.entity';
import { Plan } from './entities/plan.entity';
import { Quota } from './entities/quota.entity';
import { Subscription } from './entities/subscription.entity';
import { UsageRecord } from './entities/usage-record.entity';
import { QuotaService } from './quota.service';

/**
 * 计费与配额模块。`QuotaService` 被 AI / 发布 / 素材 / 工作区模块复用（配额闸门 + 用量记录），
 * 因此必须导出它——这样各业务模块只需 import BillingModule。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Plan, Subscription, UsageRecord, Invoice, Quota, WorkspaceMember, MediaAsset])],
  controllers: [BillingController],
  providers: [QuotaService],
  exports: [QuotaService],
})
export class BillingModule {}
