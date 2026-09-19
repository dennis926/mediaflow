import { IsOptional, IsString, Length } from 'class-validator';

/**
 * 软删工作区的确认体（B0.4）。
 * 二次确认：必须原样输入工作区名称，防止误点删掉整个工作区。
 */
export class DeleteWorkspaceDto {
  @IsString()
  @Length(1, 100)
  confirmName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
