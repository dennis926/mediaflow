import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoService } from '../../common/crypto.service';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { SystemSetting } from './entities/system-setting.entity';
import { PublicConfigController } from './public-config.controller';
import { AiConfigController } from './ai-config.controller';
import { ChannelsController } from './channels.controller';
import { PermissionsController } from './permissions.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ProviderConfigService } from '../ai/provider-config.service';

@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting])],
  controllers: [SettingsController, PublicConfigController, AiConfigController, ChannelsController, PermissionsController],
  providers: [SettingsService, CryptoService, AiProviderFactory, ProviderConfigService],
  exports: [SettingsService, AiProviderFactory, ProviderConfigService],
})
export class SettingsModule {}
