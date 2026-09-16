import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AiAdaptDto } from '../ai/dto/ai.dto';
import { ContentVariant } from './entities/content-variant.entity';
import { AdaptResult, ContentService } from './content.service';

@Controller('contents')
export class ContentVariantController {
  constructor(private readonly contentService: ContentService) {}

  @Get(':id/variants')
  list(@Param('id', ParseUUIDPipe) id: string): Promise<ContentVariant[]> {
    return this.contentService.listVariants(id);
  }

  /** Generates per-platform versions of one content through the AI service. */
  @Post(':id/ai-adapt')
  adapt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AiAdaptDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<AdaptResult> {
    return this.contentService.aiAdapt(id, dto, toActor(user));
  }
}
