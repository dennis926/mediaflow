import { IsOptional, IsString, Length } from 'class-validator';

/**
 * 永久清除（purge）的二次确认体（B0.4 第 4 步）。
 * 不可逆操作：必须同时给出工作区名称与固定串「永久删除」。
 */
export class PurgeWorkspaceDto {
  @IsString()
  @Length(1, 100)
  confirmName!: string;

  /** 固定串：永久删除 */
  @IsString()
  @Length(1, 20)
  confirmText!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
