import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PlatformCode } from '@mediaflow/shared';

export class CreatePublishTaskDto {
  @IsUUID('4', { message: 'contentId 必须是合法的 UUID' })
  contentId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: '至少选择一个发布平台' })
  @IsIn(Object.values(PlatformCode), { each: true, message: '存在不支持的平台' })
  platforms!: PlatformCode[];

  @IsOptional()
  @IsUUID('4', { message: 'socialAccountId 必须是合法的 UUID' })
  socialAccountId?: string;

  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'scheduledAt 必须是 ISO 时间字符串' })
  scheduledAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  maxAttempts?: number;
}
