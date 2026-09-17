import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Platform } from './entities/platform.entity';
import { SocialAccount } from './entities/social-account.entity';
import { SocialAccountController } from './social-account.controller';
import { SocialAccountService } from './social-account.service';

@Module({
  imports: [TypeOrmModule.forFeature([Platform, SocialAccount])],
  controllers: [SocialAccountController],
  providers: [SocialAccountService],
  exports: [SocialAccountService],
})
export class PlatformModule {}
