import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
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

  @IsOptional()
  @IsIn(Object.values(ContentStatus))
  status?: ContentStatus;

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
