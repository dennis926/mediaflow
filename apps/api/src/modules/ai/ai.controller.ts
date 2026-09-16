import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AiGeneration } from './entities/ai-generation.entity';
import { AiService } from './ai.service';
import { ComplianceReport } from './ai.types';
import { ComplianceCheckDto, GenerateTextDto, OptimizeTitleDto, QueryAiGenerationDto } from './dto/ai.dto';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('status')
  status(): { provider: string; model: string } {
    return { provider: this.aiService.providerName, model: this.aiService.modelName };
  }

  @Post('generate')
  generate(@Body() dto: GenerateTextDto): Promise<{ text: string; generationId: string }> {
    return this.aiService.generate(dto.prompt, dto.tone, {
      inputRefs: { title: dto.title ?? null },
      requestedBy: null,
    });
  }

  @Post('optimize-title')
  optimizeTitle(@Body() dto: OptimizeTitleDto): Promise<{ titles: string[]; generationId: string }> {
    return this.aiService.optimizeTitle(dto.title, dto.platform, dto.keywords, {});
  }

  @Post('compliance-check')
  complianceCheck(@Body() dto: ComplianceCheckDto): Promise<ComplianceReport> {
    return this.aiService.complianceCheck(
      { text: dto.text, platform: dto.platform, useAiReview: dto.useAiReview },
      {},
    );
  }

  @Get('generations')
  generations(@Query() query: QueryAiGenerationDto): Promise<{
    items: AiGeneration[];
    meta: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    return this.aiService.listGenerations(query);
  }
}
