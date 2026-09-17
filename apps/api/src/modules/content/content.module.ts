import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { NotificationModule } from '../notification/notification.module';
import { ContentController } from './content.controller';
import { ContentReviewController } from './content-review.controller';
import { ContentReviewService } from './content-review.service';
import { ContentService } from './content.service';
import { ContentVariantController } from './content-variant.controller';
import { ContentReview } from './entities/content-review.entity';
import { ContentVariant } from './entities/content-variant.entity';
import { Content } from './entities/content.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Content, ContentVariant, ContentReview]), AiModule, NotificationModule],
  controllers: [ContentController, ContentVariantController, ContentReviewController],
  providers: [ContentService, ContentReviewService],
  exports: [ContentService, ContentReviewService],
})
export class ContentModule {}
