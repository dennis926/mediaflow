import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { SettingsModule } from '../settings/settings.module';
import { AiService } from './ai.service';
import { ModelPricingService } from './model-pricing.service';
import { AiGeneration } from './entities/ai-generation.entity';
import { OfficialPriceStore } from './pricing/official-price.store';
import { OfficialPriceRefreshTask } from './pricing/official-price-refresh.task';

@Module({
  imports: [TypeOrmModule.forFeature([AiGeneration]), SettingsModule, BillingModule],
  controllers: [AiController],
  providers: [AiService, ModelPricingService, OfficialPriceStore, OfficialPriceRefreshTask],
  exports: [AiService, ModelPricingService, OfficialPriceStore],
})
export class AiModule {}
