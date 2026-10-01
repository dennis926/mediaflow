import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoService } from '../../common/crypto.service';
import { MediaAsset } from './entities/media-asset.entity';
import { MediaController, PublicMediaController } from './media.controller';
import { MediaLinkService } from './media-link.service';
import { MediaService } from './media.service';
import { MediaUploadInterceptor } from './media-upload.interceptor';
import { MediaUploadLimiter } from './media-upload.limiter';

@Module({
  imports: [BillingModule, TypeOrmModule.forFeature([MediaAsset])],
  controllers: [MediaController, PublicMediaController],
  // CryptoService 无状态（与 workspace/platform 模块同样直接提供）：素材链接签名要主密钥
  providers: [MediaService, MediaLinkService, CryptoService, MediaUploadLimiter, MediaUploadInterceptor],
  exports: [MediaService],
})
export class MediaModule {}
