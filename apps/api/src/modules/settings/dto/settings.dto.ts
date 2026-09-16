import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SettingItemDto {
  @IsString()
  @Length(1, 80)
  key!: string;

  @IsString()
  @Length(0, 2048)
  value!: string;
}

export class UpdateSettingsDto {
  @IsArray()
  @ArrayNotEmpty({ message: '没有需要保存的配置' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SettingItemDto)
  items!: SettingItemDto[];
}

export class TestAiDto {
  /** Optional one-off key so an operator can test before saving. */
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  model?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  baseUrl?: string;
}
