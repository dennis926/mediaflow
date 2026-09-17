import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PlatformCode } from '@mediaflow/shared';

export const KNOWLEDGE_CATEGORIES = ['brand', 'product', 'ingredient', 'compliance', 'faq', 'tone'] as const;

export class CreateKnowledgeDto {
  @IsString()
  @Length(1, 80)
  brand!: string;

  @IsIn(KNOWLEDGE_CATEGORIES, { message: '分类不合法' })
  category!: (typeof KNOWLEDGE_CATEGORIES)[number];

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 5000)
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsArray()
  @IsIn(Object.values(PlatformCode), { each: true })
  platforms?: PlatformCode[];

  @IsOptional()
  @IsString()
  @Length(1, 512)
  sourceUrl?: string;
}

export class UpdateKnowledgeDto extends CreateKnowledgeDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryKnowledgeDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  keyword?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  brand?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_CATEGORIES)
  category?: (typeof KNOWLEDGE_CATEGORIES)[number];

  @IsOptional()
  @IsIn(['true', 'false'])
  isActive?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class ImportKnowledgeDto {
  @IsString()
  @Length(1, 80)
  brand!: string;

  @IsIn(KNOWLEDGE_CATEGORIES, { message: '分类不合法' })
  category!: (typeof KNOWLEDGE_CATEGORIES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  /** 默认 false：导入先落成停用草稿，人工确认后再批量启用。 */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  autoActivate?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(40)
  maxChunks?: number;
}

export class BatchActivateDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsBoolean()
  isActive!: boolean;
}

export class PreviewKnowledgeDto {
  @IsUUID('4')
  contentId!: string;

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}
