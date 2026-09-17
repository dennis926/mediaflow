import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
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

export class CommitChunkDto {
  @IsString()
  @Length(20, 20000, { message: '每一片内容需 20-20000 字' })
  content!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsBoolean()
  fromOcr?: boolean;
}

/** 复核校对后提交：以人工确认（可能已修改）的分片为准入库。 */
export class CommitImportDto {
  @IsString()
  @Length(1, 100)
  brand!: string;

  @IsIn(KNOWLEDGE_CATEGORIES)
  category!: (typeof KNOWLEDGE_CATEGORIES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  activate?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  sourceFileName?: string;

  /** 解析阶段返回的临时文件名；提交时移入留档目录。 */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  tempFile?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => CommitChunkDto)
  chunks!: CommitChunkDto[];
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
