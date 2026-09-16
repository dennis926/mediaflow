import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { PlatformCode } from '@mediaflow/shared';
import { AiTaskType } from '../ai.types';

export class GenerateTextDto {
  @IsString()
  @Length(2, 1000, { message: 'prompt 长度需在 2-1000 字之间' })
  prompt!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  tone?: string;
}

export class OptimizeTitleDto {
  @IsString()
  @Length(2, 200)
  title!: string;

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];
}

export class ComplianceCheckDto {
  @IsString()
  @Length(1, 20000)
  text!: string;

  @IsOptional()
  @IsIn(Object.values(PlatformCode))
  platform?: PlatformCode;

  @IsOptional()
  @IsBoolean()
  useAiReview?: boolean;
}

export class AiAdaptDto {
  @IsArray()
  @ArrayNotEmpty({ message: '至少选择一个平台' })
  @ArrayMaxSize(7)
  @IsIn(Object.values(PlatformCode), { each: true })
  platforms!: PlatformCode[];

  @IsOptional()
  @IsString()
  @Length(1, 100)
  tone?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  /** Replace existing variants for the same platform instead of skipping them. */
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;
}

export class QueryAiGenerationDto {
  @IsOptional()
  @IsIn(['generate', 'adapt', 'optimize_title', 'compliance_check'])
  taskType?: AiTaskType;

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
