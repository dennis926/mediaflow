import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PlatformCode } from '@mediaflow/shared';
import { Capability } from '../auth/capabilities';
import { AuthUser } from '../auth/auth.types';
import { toActor } from '../auth/actor.util';
import { CurrentUser } from '../auth/current-user.decorator';
import { ContentTemplate } from './entities/content-template.entity';
import { ContentTemplateService, TemplatePage } from './content-template.service';

class CreateTemplateDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string;

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @IsString()
  @Length(0, 40)
  category?: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 20000)
  body!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateTemplateDto extends CreateTemplateDto {}

/**
 * 文案模板库：内容创作时一键套用，沉淀公司自己的写法。
 * 读操作所有登录角色可用；写操作走 content.write 能力点（可在权限矩阵里调整）。
 */
@Controller('content-templates')
export class ContentTemplateController {
  constructor(private readonly templates: ContentTemplateService) {}

  @Get()
  list(@Query() query: { keyword?: string; platform?: string; category?: string; page?: number; pageSize?: number }): Promise<TemplatePage> {
    return this.templates.list(query);
  }

  @Get('categories')
  categories(): Promise<Array<{ category: string; count: number }>> {
    return this.templates.categories();
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<ContentTemplate> {
    return this.templates.get(id);
  }

  @Capability('content.write')
  @Post()
  create(@Body() dto: CreateTemplateDto, @CurrentUser() user?: AuthUser): Promise<ContentTemplate> {
    return this.templates.create(dto, toActor(user));
  }

  @Capability('content.write')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto, @CurrentUser() user?: AuthUser): Promise<ContentTemplate> {
    return this.templates.update(id, dto, toActor(user));
  }

  /** 使用模板：累加引用次数并返回内容，前端据此预填编辑器 */
  @Capability('content.write')
  @Post(':id/use')
  use(@Param('id', ParseUUIDPipe) id: string): Promise<ContentTemplate> {
    return this.templates.use(id);
  }

  @Capability('content.write')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser): Promise<{ id: string }> {
    return this.templates.remove(id, toActor(user));
  }
}
