import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

/**
 * 人工发布回填（B1 之前的"无平台密钥"主路径）。
 *
 * 背景：公众号按平台规则**禁止 API 发布**，视频号/知乎/头条/百家号等也主要靠浏览器插件填充 + 人工确认。
 * 这些任务在系统里的状态是 `manual_required`（待人工发布），但此前**没有"我发完了"的回填入口**——
 * 任务会永远停在待人工发布，数据也回不来。这个 DTO 就是那条回填路径：把发布结果（链接/平台侧 id/备注）写回任务。
 */
export class MarkManualPublishedDto {
  /** 发布后的公开链接（填了就写进任务，数据中心与审计都能追溯） */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: '链接必须是 http/https 开头的完整地址' })
  @MaxLength(512)
  url?: string;

  /** 平台侧的内容 id（可选，例如公众号的 msgid） */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  postId?: string;

  /** 备注（可选）：例如"已发但未群发，仅发布到草稿箱" */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class MarkManualFailedDto {
  /** 失败原因（必填）：人工发布失败也要留痕，否则任务只会停在待发布说不清原因 */
  @IsString()
  @MinLength(2, { message: '请填写失败原因（至少 2 个字）' })
  @MaxLength(500)
  reason!: string;
}
