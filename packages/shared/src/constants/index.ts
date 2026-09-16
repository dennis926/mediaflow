import { PlatformCode, PublishMode } from '../types/platform';

/** Unified business codes used by every API response. */
export const ApiCode = {
  Success: 0,
  BadRequest: 40000,
  Unauthorized: 40100,
  Forbidden: 40300,
  NotFound: 40400,
  Conflict: 40900,
  TooManyRequests: 42900,
  InternalError: 50000,
} as const;

export type ApiCodeValue = (typeof ApiCode)[keyof typeof ApiCode];

/** Mandatory visible mark for AI generated content (Chinese regulation). */
export const AI_DISCLOSURE_TEXT = '（本文由 AI 辅助生成）';

/** Invisible mark written into media metadata for AI generated assets. */
export const AI_METADATA_KEY = 'ai_generated';
export const AI_METADATA_PROVIDER = 'MediaFlow';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const PUBLISH_RETRY = {
  maxAttempts: 3,
  intervalMs: 5 * 60 * 1000,
} as const;

export const PUBLISH_MODES: Record<PlatformCode, PublishMode> = {
  [PlatformCode.WechatMp]: PublishMode.Manual,
  [PlatformCode.WechatVideo]: PublishMode.Plugin,
  [PlatformCode.Douyin]: PublishMode.Api,
  [PlatformCode.Xiaohongshu]: PublishMode.Api,
  [PlatformCode.Zhihu]: PublishMode.Plugin,
  [PlatformCode.Toutiao]: PublishMode.Plugin,
  [PlatformCode.Baijiahao]: PublishMode.Plugin,
};

export const PLATFORM_LABELS: Record<PlatformCode, string> = {
  [PlatformCode.WechatMp]: '微信公众号',
  [PlatformCode.WechatVideo]: '视频号',
  [PlatformCode.Douyin]: '抖音',
  [PlatformCode.Xiaohongshu]: '小红书',
  [PlatformCode.Zhihu]: '知乎',
  [PlatformCode.Toutiao]: '今日头条',
  [PlatformCode.Baijiahao]: '百家号',
};

/** Platforms whose interactive APIs (DM / comments) were revoked and are out of scope. */
export const INTERACTION_DISABLED_PLATFORMS: PlatformCode[] = [PlatformCode.Douyin];

export * from './labels';
