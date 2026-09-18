import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAsset } from './entities/media-asset.entity';
import { MediaController, PublicMediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaUploadInterceptor } from './media-upload.interceptor';
import { MediaUploadLimiter } from './media-upload.limiter';

@Module({
  imports: [TypeOrmModule.forFeature([MediaAsset])],
  controllers: [MediaController, PublicMediaController],
  providers: [MediaService, MediaUploadLimiter, MediaUploadInterceptor],
  exports: [MediaService],
})
export class MediaModule {}
