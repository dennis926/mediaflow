import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { NotificationModule } from '../notification/notification.module';
import { SettingsModule } from '../settings/settings.module';
import { ContentController } from './content.controller';
import { ContentReviewController } from './content-review.controller';
import { ContentReviewService } from './content-review.service';
import { DocumentParserService } from './document-parser.service';
import { OcrService } from './ocr.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeTransferService } from './knowledge.transfer.service';
import { ContentService } from './content.service';
import { ContentVariantController } from './content-variant.controller';
import { BrandKnowledge } from './entities/brand-knowledge.entity';
import { ContentReview } from './entities/content-review.entity';
import { ContentVariant } from './entities/content-variant.entity';
import { Content } from './entities/content.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Content, ContentVariant, ContentReview, BrandKnowledge]), AiModule, NotificationModule, SettingsModule],
  controllers: [ContentController, ContentVariantController, ContentReviewController, KnowledgeController],
  providers: [ContentService, ContentReviewService, KnowledgeService, KnowledgeTransferService, DocumentParserService, OcrService],
  exports: [ContentService, ContentReviewService, KnowledgeService],
})
export class ContentModule {}
