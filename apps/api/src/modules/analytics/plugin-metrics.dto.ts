import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { PlatformCode } from '@mediaflow/shared';

/** Numbers scraped from a platform page by the browser extension. */
export class PluginMetricsDto {
  @IsIn(Object.values(PlatformCode))
  platform!: PlatformCode;

  @IsOptional()
  @IsUUID('4')
  socialAccountId?: string;

  @IsOptional()
  @IsUUID('4')
  contentId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  postId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  views?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  likes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  comments?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  shares?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  favorites?: number;
}
