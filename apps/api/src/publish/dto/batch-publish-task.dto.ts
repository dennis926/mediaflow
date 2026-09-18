import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';

/** 发布任务批量操作：一次最多 100 条。 */
export class BatchPublishTaskDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsIn(['cancel', 'retry'])
  action!: 'cancel' | 'retry';
}
