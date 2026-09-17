import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoService } from '../../common/crypto.service';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { SystemSetting } from './entities/system-setting.entity';
import { PublicConfigController } from './public-config.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting])],
  controllers: [SettingsController, PublicConfigController],
  providers: [SettingsService, CryptoService, AiProviderFactory],
  exports: [SettingsService, AiProviderFactory],
})
export class SettingsModule {}
