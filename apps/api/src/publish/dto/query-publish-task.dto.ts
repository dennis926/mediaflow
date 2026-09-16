import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PlatformCode, PublishTaskStatus } from '@mediaflow/shared';

export class QueryPublishTaskDto {
  @IsOptional()
  @IsIn(Object.values(PublishTaskStatus), { message: '状态取值非法' })
  status?: PublishTaskStatus;

  @IsOptional()
  @IsIn(Object.values(PlatformCode), { message: '平台取值非法' })
  platform?: PlatformCode;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value === undefined ? undefined : value))
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
