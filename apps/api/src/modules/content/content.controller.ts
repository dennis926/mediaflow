import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
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

  @Post()
  create(@Body() dto: CreateContentDto): Promise<Content> {
    return this.contentService.create(dto, { name: 'api' });
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<Content> {
    return this.contentService.get(id);
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateContentDto): Promise<Content> {
    return this.contentService.update(id, dto, { name: 'api' });
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<{ id: string; deletedAt: Date }> {
    return this.contentService.remove(id, { name: 'api' });
  }

  /** Records that the AI disclosure has been reviewed before publishing. */
  @Patch(':id/ai-flag-check')
  aiFlagCheck(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AiFlagCheckDto): Promise<Content> {
    return this.contentService.setAiFlagChecked(id, dto, { name: 'api' });
  }
}
