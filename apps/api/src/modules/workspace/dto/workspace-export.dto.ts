import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/** 申请导出的参数（B0.4 第 3 步）。 */
export class RequestWorkspaceExportDto {
  /** 是否包含素材二进制；关闭后只导出数据（用于超大工作区）。默认 true */
  @IsOptional()
  @IsBoolean()
  includeMedia?: boolean;

  /** 是否包含审计日志。默认 true */
  @IsOptional()
  @IsBoolean()
  includeAudit?: boolean;

  /** 备注（记录导出事由，进入审计） */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}
