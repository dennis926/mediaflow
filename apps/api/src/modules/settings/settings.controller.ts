import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Capability } from '../auth/capabilities';
import { UpdateSettingsDto, TestAiDto } from './dto/settings.dto';
import { SettingGroupView, SettingsService } from './settings.service';
import { AiProviderFactory } from '../ai/ai-provider.factory';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly aiProviders: AiProviderFactory,
  ) {}

  /** Masked configuration for the admin UI; secrets only expose their last four characters. */
  @Capability('settings.write')
  @Get()
  list(): Promise<SettingGroupView[]> {
    return this.settingsService.list();
  }

  @Capability('settings.write')
  @Put()
  update(@Body() dto: UpdateSettingsDto, @CurrentUser() user?: AuthUser): Promise<SettingGroupView[]> {
    return this.settingsService.updateMany(dto.items, toActor(user));
  }

  /** Verifies the AI credentials (optionally the values currently typed in the form). */
  @Capability('settings.write')
  @Post('ai/test')
  testAi(
    @Body() dto: TestAiDto,
  ): Promise<{ ok: boolean; provider: string; model: string; latencyMs: number; reply?: string; error?: string }> {
    return this.aiProviders.test(dto);
  }
}
