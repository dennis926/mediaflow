import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoService } from '../../common/crypto.service';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { SystemSetting } from './entities/system-setting.entity';
import { PublicConfigController } from './public-config.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ProviderConfigService } from '../ai/provider-config.service';

@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting])],
  controllers: [SettingsController, PublicConfigController],
  providers: [SettingsService, CryptoService, AiProviderFactory, ProviderConfigService],
  exports: [SettingsService, AiProviderFactory, ProviderConfigService],
})
export class SettingsModule {}
