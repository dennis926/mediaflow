import { PlatformCode, PublishMode } from '@mediaflow/shared';
import { requestJson } from '../http';
import {
  AdapterCapabilities,
  AdapterContext,
  AdapterCredentials,
  AnalyticsSnapshot,
  ChannelAdapter,
  PublishPayload,
  PublishResult,
} from '../types';

const BAIJIAHAO_API = 'https://baijiahao.baidu.com/builderinner/open/resource/article';

/** 百家号开放平台错误码 → 可读信息（文档 + 实测）。 */
const ERRNO_MESSAGES: Record<number, string> = {
  2: '参数错误',
  60001001: '授权校验失败（app_id 或 app_token 无效）',
  60001002: '发文篇数达到当日上限',
  60001003: '内容重复提交（百家号去重策略命中）',
  60001004: '账号状态异常，无法发布',
};

interface BaijiahaoResponse {
  errno?: number;
  errmsg?: string;
  data?: { article_id?: string } | null;
}

/**
 * 百家号适配器（官方开发者接口，图文）。
 *
 * 接入流程（官方文档 baijiahao.baidu.com/builder/author/openauth/openauthProtection）：
 *  1. 百家号后台开通「开发者服务」，获得 app_id + app_token
 *  2. POST JSON 到 /builderinner/open/resource/article/publish
 *
 * 实测确认：
 *  - 请求为 HTTPS POST + application/json
 *  - 凭证错误返回 {"errno":60001001,"errmsg":"授权校验失败"}（2026-09 直连验证）
 *  - 相同文章禁止重复提交（平台去重）
 *  - 发文量受账号每日篇数限制
 */
export class BaijiahaoAdapter implements ChannelAdapter {
  readonly platform = PlatformCode.Baijiahao;

  readonly capabilities: AdapterCapabilities = {
    mode: PublishMode.Api,
    canPublish: true,
    /** 官方文档未提供数据回采接口（仅发布/撤回），统计走 Plugin 模式或后续协商开放。 */
    canFetchAnalytics: false,
    canInteract: false,
    supportsSchedule: false,
    maxBodyLength: 20000,
    supportedMedia: ['image'],
  };

  constructor(private readonly context: AdapterContext = {}) {}

  /**
   * 百家号开发者服务不提供 OAuth 授权码流程：app_token 在百家号后台开通后长期有效，
   * 直接作为凭证存储，无需 code 换取。
   */
  async auth(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    if (!credentials.appId || !credentials.appSecret) {
      throw new Error('百家号接入需要在后台开通开发者服务，获取 app_id 与 app_token');
    }
    return { ...credentials, accessToken: credentials.appSecret };
  }

  /** app_token 长期有效，无需刷新。 */
  async refreshToken(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    return credentials;
  }

  async publish(payload: PublishPayload, credentials: AdapterCredentials): Promise<PublishResult> {
    if (!credentials.appId || !credentials.appSecret) {
      throw new Error('缺少百家号 app_id / app_token，请先在百家号后台开通开发者服务');
    }

    const title = payload.title.trim();
    if (title.length < 8 || title.length > 40) {
      throw new Error(`百家号标题限 8-40 个字符（当前 ${title.length} 个）`);
    }
    if (payload.body.length > this.capabilities.maxBodyLength) {
      throw new Error(`百家号正文限 ${this.capabilities.maxBodyLength} 字符（当前 ${payload.body.length}）`);
    }

    const coverImages = payload.coverUrl ? [payload.coverUrl, ...payload.mediaUrls].slice(0, 3) : payload.mediaUrls.slice(0, 3);
    const body: Record<string, unknown> = {
      app_id: credentials.appId,
      app_token: credentials.appSecret,
      title,
      content: payload.body,
      /** 原文地址必填：无来源时用任务标识占位，避免接口拒绝。 */
      origin_url: `https://example.com/mediaflow/${payload.taskId}`,
    };
    if (coverImages.length > 0) {
      body.cover_images = JSON.stringify(coverImages.map((src) => ({ src })));
    }

    const response = await requestJson<BaijiahaoResponse>(this.context, `${BAIJIAHAO_API}/publish`, {
      method: 'POST',
      body,
    });

    if (response.errno !== 0) {
      const message = ERRNO_MESSAGES[response.errno ?? 0] ?? response.errmsg ?? '未知错误';
      throw new Error(`百家号发布失败（${response.errno}）：${message}`);
    }

    const articleId = response.data?.article_id;
    return {
      status: 'published',
      platformPostId: articleId,
      platformUrl: articleId ? `https://baijiahao.baidu.com/s?id=${articleId}` : undefined,
      message: '已通过官方接口提交，进入百家号审核队列',
      raw: { errno: response.errno, article_id: articleId },
    };
  }

  /**
   * 官方文档未开放数据回采接口。返回零值快照保持接口契约，
   * 统计数据待百度后续开放（或由运营在百家号后台查看）。
   */
  async fetchAnalytics(postId: string): Promise<AnalyticsSnapshot> {
    return {
      platform: this.platform,
      postId,
      capturedAt: (this.context.now?.() ?? new Date()).toISOString(),
      metrics: { views: 0, likes: 0, comments: 0, shares: 0, favorites: 0 },
    };
  }
}
