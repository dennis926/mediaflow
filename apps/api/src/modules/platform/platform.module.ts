import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoService } from '../../common/crypto.service';
import { SettingsModule } from '../settings/settings.module';
import { Platform } from './entities/platform.entity';
import { SocialAccount } from './entities/social-account.entity';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { SocialAccountController } from './social-account.controller';
import { SocialAccountService } from './social-account.service';
import { TokenRefreshTask } from './token-refresh.task';

@Module({
  imports: [TypeOrmModule.forFeature([Platform, SocialAccount]), ConfigModule, SettingsModule],
  controllers: [SocialAccountController, OAuthController],
  providers: [SocialAccountService, OAuthService, TokenRefreshTask, CryptoService],
  exports: [SocialAccountService, OAuthService],
})
export class PlatformModule {}
