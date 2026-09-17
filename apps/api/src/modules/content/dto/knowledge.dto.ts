import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
  Max,
  Min,
} from 'class-validator';
import { PlatformCode } from '@mediaflow/shared';
import { DEFAULT_KNOWLEDGE_CATEGORIES, IsKnowledgeCategory, type KnowledgeCategoryDef } from '../knowledge.categories';

export const KNOWLEDGE_CATEGORY_CODES = DEFAULT_KNOWLEDGE_CATEGORIES.map((item) => item.code);

export class CreateKnowledgeDto {
  @IsString()
  @Length(1, 80)
  brand!: string;

  @IsKnowledgeCategory()
  category!: string;

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

  /** 内容由 AI 起草（人工确认后保存），保存时打标。 */
  @IsOptional()
  @IsBoolean()
  aiGenerated?: boolean;
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
  @IsKnowledgeCategory()
  category?: string;

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

  @IsKnowledgeCategory()
  category!: string;

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

  @IsKnowledgeCategory()
  category!: string;

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

/** 知识库 AI 体检/生成相关的请求体。 */
export class AiGenerateKnowledgeDto {
  @IsString()
  @Length(1, 80)
  brand!: string;

  @IsKnowledgeCategory()
  category!: string;

  /** 运营给的要点，几行都行。 */
  @IsString()
  @Length(5, 2000)
  points!: string;

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  tone?: string;
}

export class AiPolishKnowledgeDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  brand?: string;

  @IsOptional()
  @IsKnowledgeCategory()
  category?: string;

  @IsString()
  @Length(20, 5000)
  content!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  instruction?: string;
}

/** 检索测试台：直接喂一段标题/正文，看会引用到哪几条资料。 */
export class MatchKnowledgeDto {
  @IsOptional()
  @IsString()
  @Length(0, 300)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

export class BatchDeleteKnowledgeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];
}

/** 保存整套分类配置（新增/改名/调色/排序/删除一次性提交）。 */
export class SaveCategoriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => KnowledgeCategoryDto)
  categories!: KnowledgeCategoryDto[];
}

export class KnowledgeCategoryDto {
  @IsString()
  @Length(1, 30)
  code!: string;

  @IsString()
  @Length(1, 20)
  label!: string;

  @IsIn(['brand', 'success', 'info', 'warning', 'danger', 'default'])
  tone!: KnowledgeCategoryDef['tone'];

  @IsOptional()
  @IsString()
  @Length(0, 100)
  description?: string;
}

export class ExportKnowledgeDto {
  @IsOptional()
  @IsIn(['json', 'csv', 'markdown'])
  format?: 'json' | 'csv' | 'markdown';

  @IsOptional()
  @IsString()
  @Length(1, 80)
  brand?: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  category?: string;

  @IsOptional()
  @IsBoolean()
  includeInactive?: boolean;
}

/** 导入第二步：行数据 + 字段映射 + 缺省值。 */
export class CommitImportDataDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  rows!: Array<Record<string, string>>;

  @IsObject()
  mapping!: Record<string, string | undefined>;

  @IsString()
  @Length(1, 80)
  brand!: string;

  @IsString()
  @Length(1, 60)
  category!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  skipDuplicates?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  sourceFileName?: string;

  /** 原生 JSON 里带的分类配置 */
  @IsOptional()
  @IsArray()
  categories?: unknown[];

  @IsOptional()
  @IsBoolean()
  applyCategories?: boolean;
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
