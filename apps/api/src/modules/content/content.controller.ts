import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { Capability } from '../auth/capabilities';
import { CurrentUser } from '../auth/current-user.decorator';
import { toActor } from '../auth/actor.util';
import { Content } from './entities/content.entity';
import { AiFlagCheckDto, ArchiveContentDto, BatchContentDto, CreateContentDto, QueryContentDto, UpdateContentDto } from './dto/content.dto';
import { ContentPage, ContentService } from './content.service';

@Controller('contents')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  list(@Query() query: QueryContentDto): Promise<ContentPage> {
    return this.contentService.list(query);
  }

  @Capability('content.write')
  @Post()
  create(@Body() dto: CreateContentDto, @CurrentUser() user?: AuthUser): Promise<Content> {
    return this.contentService.create(dto, toActor(user));
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<Content> {
    return this.contentService.get(id);
  }

  @Capability('content.write')
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContentDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<Content> {
    return this.contentService.update(id, dto, toActor(user));
  }

  /** 批量操作：归档/取消归档/删除（逐条返回失败原因，不整批中断） */
  @Capability('content.write')
  @Post('batch')
  batch(
    @Body() dto: BatchContentDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ affected: number; failed: Array<{ id: string; reason: string }> }> {
    return this.contentService.batch(dto.ids, dto.action, toActor(user));
  }

  /** 版本历史（新到旧） */
  @Get(':id/revisions')
  revisions(@Param('id', ParseUUIDPipe) id: string) {
    return this.contentService.listRevisions(id);
  }

  /** 回滚到某个历史版本（会先把当前状态留档） */
  @Capability('content.write')
  @Post(':id/revisions/:revisionId/restore')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.contentService.restoreRevision(id, revisionId, toActor(user));
  }

  /** 归档 / 取消归档（归档后不再参与发布与检索，但保留历史） */
  @Capability('content.write')
  @Patch(':id/archive')
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchiveContentDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<Content> {
    return this.contentService.archive(id, dto.archived, toActor(user));
  }

  @Capability('content.write')
  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ id: string; deletedAt: Date }> {
    return this.contentService.remove(id, toActor(user));
  }

  /** Records that the AI disclosure has been reviewed before publishing. */
  @Capability('content.write')
  @Patch(':id/ai-flag-check')
  aiFlagCheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AiFlagCheckDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<Content> {
    return this.contentService.setAiFlagChecked(id, dto, toActor(user));
  }
}
