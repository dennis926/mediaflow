import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { toActor } from '../auth/actor.util';
import { Content } from './entities/content.entity';
import { AiFlagCheckDto, CreateContentDto, QueryContentDto, UpdateContentDto } from './dto/content.dto';
import { ContentPage, ContentService } from './content.service';

@Controller('contents')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  list(@Query() query: QueryContentDto): Promise<ContentPage> {
    return this.contentService.list(query);
  }

  @Roles('owner', 'admin', 'editor')
  @Post()
  create(@Body() dto: CreateContentDto, @CurrentUser() user?: AuthUser): Promise<Content> {
    return this.contentService.create(dto, toActor(user));
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<Content> {
    return this.contentService.get(id);
  }

  @Roles('owner', 'admin', 'editor')
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContentDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<Content> {
    return this.contentService.update(id, dto, toActor(user));
  }

  @Roles('owner', 'admin', 'editor')
  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<{ id: string; deletedAt: Date }> {
    return this.contentService.remove(id, toActor(user));
  }

  /** Records that the AI disclosure has been reviewed before publishing. */
  @Roles('owner', 'admin', 'editor')
  @Patch(':id/ai-flag-check')
  aiFlagCheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AiFlagCheckDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<Content> {
    return this.contentService.setAiFlagChecked(id, dto, toActor(user));
  }
}
