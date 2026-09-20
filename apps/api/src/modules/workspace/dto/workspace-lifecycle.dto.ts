import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

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

  /**
   * 软保护：当这是租户里最后一个 active/archived 工作区时，必须显式传 true 才能删除。
   * 不做硬阻止——SaaS 场景下用户可能确实想关停账号，但必须让他知道后果并留痕。
   */
  @IsOptional()
  @IsBoolean()
  confirmLastWorkspace?: boolean;
}
