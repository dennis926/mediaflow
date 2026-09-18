import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { NotificationModule } from '../notification/notification.module';
import { SettingsModule } from '../settings/settings.module';
import { ContentController } from './content.controller';
import { ContentTemplateController } from './content-template.controller';
import { ContentReviewController } from './content-review.controller';
import { ContentReviewService } from './content-review.service';
import { DocumentParserService } from './document-parser.service';
import { OcrService } from './ocr.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeTransferService } from './knowledge.transfer.service';
import { ContentService } from './content.service';
import { ContentTemplateService } from './content-template.service';
import { ContentVariantController } from './content-variant.controller';
import { BrandKnowledge } from './entities/brand-knowledge.entity';
import { ContentReview } from './entities/content-review.entity';
import { ContentRevision } from './entities/content-revision.entity';
import { ContentTemplate } from './entities/content-template.entity';
import { ContentVariant } from './entities/content-variant.entity';
import { Content } from './entities/content.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Content, ContentVariant, ContentReview, BrandKnowledge, ContentRevision, ContentTemplate]), AiModule, NotificationModule, SettingsModule],
  controllers: [ContentController, ContentVariantController, ContentReviewController, KnowledgeController, ContentTemplateController],
  providers: [ContentService, ContentReviewService, KnowledgeService, KnowledgeTransferService, ContentTemplateService, DocumentParserService, OcrService],
  exports: [ContentService, ContentReviewService, KnowledgeService, ContentTemplateService],
})
export class ContentModule {}
