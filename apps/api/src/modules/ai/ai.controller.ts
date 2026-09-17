import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { Capability } from '../auth/capabilities';
import { Roles } from '../auth/roles.decorator';
import { AiGeneration } from './entities/ai-generation.entity';
import { AiService } from './ai.service';
import { ComplianceReport } from './ai.types';
import { ComplianceCheckDto, GenerateTextDto, OptimizeTitleDto, QueryAiGenerationDto } from './dto/ai.dto';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Public()
  @Get('status')
  status(): Promise<{ provider: string; model: string }> {
    return this.aiService.describe();
  }

  @Capability('content.write')
  @Post('generate')
  generate(
    @Body() dto: GenerateTextDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ text: string; generationId: string }> {
    return this.aiService.generate(dto.prompt, dto.tone, {
      inputRefs: { title: dto.title ?? null },
      requestedBy: toActor(user).id ?? null,
    });
  }

  @Capability('content.write')
  @Post('optimize-title')
  optimizeTitle(
    @Body() dto: OptimizeTitleDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ titles: string[]; generationId: string }> {
    return this.aiService.optimizeTitle(dto.title, dto.platform, dto.keywords, { requestedBy: toActor(user).id ?? null });
  }

  @Capability('content.write')
  @Post('compliance-check')
  complianceCheck(
    @Body() dto: ComplianceCheckDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<ComplianceReport> {
    return this.aiService.complianceCheck({ text: dto.text, platform: dto.platform, useAiReview: dto.useAiReview }, {
      requestedBy: toActor(user).id ?? null,
    });
  }

  @Roles('owner', 'admin', 'editor', 'reviewer', 'viewer')
  @Get('generations')
  generations(@Query() query: QueryAiGenerationDto): Promise<{
    items: AiGeneration[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    return this.aiService.listGenerations(query);
  }
}
