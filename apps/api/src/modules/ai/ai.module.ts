import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { aiProviderProvider } from './ai.provider';
import { AiService } from './ai.service';
import { AiGeneration } from './entities/ai-generation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AiGeneration])],
  controllers: [AiController],
  providers: [AiService, aiProviderProvider],
  exports: [AiService],
})
export class AiModule {}
