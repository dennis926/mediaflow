import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { CreateKnowledgeDto, PreviewKnowledgeDto, QueryKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';
import { BrandKnowledge } from './entities/brand-knowledge.entity';
import { KnowledgeMatch, KnowledgePage, KnowledgeService } from './knowledge.service';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  /** 全部登录角色都能查：写内容的人需要知道品牌口径 */
  @Get()
  list(@Query() query: QueryKnowledgeDto): Promise<KnowledgePage> {
    return this.knowledgeService.list(query);
  }

  @Get('brands')
  brands(): Promise<Array<{ brand: string; count: number }>> {
    return this.knowledgeService.brands();
  }

  /** 预览本次生成会引用哪些资料（生成前可确认） */
  @Get('preview')
  preview(@Query() query: PreviewKnowledgeDto): Promise<{ matches: KnowledgeMatch[] }> {
    return this.knowledgeService.previewForContent(query.contentId, query.platform, query.limit ?? 5);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<BrandKnowledge> {
    return this.knowledgeService.get(id);
  }

  @Roles('owner', 'admin', 'editor')
  @Post()
  create(@Body() dto: CreateKnowledgeDto, @CurrentUser() user?: AuthUser): Promise<BrandKnowledge> {
    return this.knowledgeService.create(dto, toActor(user));
  }

  @Roles('owner', 'admin', 'editor')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKnowledgeDto, @CurrentUser() user?: AuthUser): Promise<BrandKnowledge> {
    return this.knowledgeService.update(id, dto, toActor(user));
  }

  @Roles('owner', 'admin', 'editor')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<{ id: string }> {
    return this.knowledgeService.remove(id, toActor(user));
  }
}
