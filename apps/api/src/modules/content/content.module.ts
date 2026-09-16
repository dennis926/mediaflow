import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { ContentVariantController } from './content-variant.controller';
import { ContentVariant } from './entities/content-variant.entity';
import { Content } from './entities/content.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Content, ContentVariant]), AiModule],
  controllers: [ContentController, ContentVariantController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
