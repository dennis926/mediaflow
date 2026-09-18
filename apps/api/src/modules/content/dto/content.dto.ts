import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
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
  Max,
  Min,
} from 'class-validator';
import { AiFlagType, ContentStatus, PlatformCode } from '@mediaflow/shared';

export class CreateContentDto {
  @IsString()
  @Length(1, 200, { message: '标题长度需在 1-200 字之间' })
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  summary?: string;

  @IsString()
  @Length(1, 50000, { message: '正文不能为空' })
  body!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  mediaUrls?: string[];

  @IsOptional()
  @IsString()
  @Length(1, 512)
  coverUrl?: string;

  /**
   * 注意：这里**故意没有** status 字段。
   * 内容状态只能由审批流（/reviews/:id）与归档接口（/contents/:id/archive）推进，
   * 客户端可写状态会导致"未审即通过"的审核绕过（审计 P1-1）。
   */

  /** Declares whether the text was produced with AI assistance; drives the legal disclosure. */
  @IsOptional()
  @IsIn(Object.values(AiFlagType))
  aiFlagType?: AiFlagType;

  @IsOptional()
  @IsUUID('4')
  brandKnowledgeId?: string;
}

export class ArchiveContentDto {
  @IsBoolean()
  archived!: boolean;
}

/** 批量操作：一次最多 100 条，避免误点把整库删了。 */
export class BatchContentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsIn(['archive', 'unarchive', 'delete'])
  action!: 'archive' | 'unarchive' | 'delete';
}

/**
 * 更新用 DTO：显式继承 Create 的白名单（不含 status）。
 * 全局 ValidationPipe 开了 whitelist，客户端多传的 status 会被直接丢弃。
 */
export class UpdateContentDto extends PartialType(CreateContentDto) {}

export class QueryContentDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  keyword?: string;

  @IsOptional()
  @IsIn(Object.values(ContentStatus))
  status?: ContentStatus;

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  aiGenerated?: boolean;

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

export class AiFlagCheckDto {
  @IsBoolean()
  checked!: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}
