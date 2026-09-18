import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { SettingsModule } from '../settings/settings.module';
import { AiService } from './ai.service';
import { ModelPricingService } from './model-pricing.service';
import { AiGeneration } from './entities/ai-generation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AiGeneration]), SettingsModule],
  controllers: [AiController],
  providers: [AiService, ModelPricingService],
  exports: [AiService, ModelPricingService],
})
export class AiModule {}
