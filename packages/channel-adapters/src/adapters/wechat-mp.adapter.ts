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

const WECHAT_API = 'https://api.weixin.qq.com';
const TOKEN_SAFETY_WINDOW_SECONDS = 300;

interface OauthTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  openid?: string;
  scope?: string;
  errcode?: number;
  errmsg?: string;
}

interface AppTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

interface ArticleTotalItem {
  ref_date?: string;
  msgid?: number;
  title?: string;
  int_page_read_count?: number;
  share_count?: number;
  add_to_fav_count?: number;
  like_num?: number;
  comment_count?: number;
}

interface ArticleTotalResponse {
  list?: ArticleTotalItem[];
  errcode?: number;
  errmsg?: string;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Official account adapter.
 *
 * Publishing through the API is forbidden by the platform rules (运营规范 3.27), so
 * publish() never calls the mass-send endpoint: it hands the content back to the operator.
 */
export class WechatMpAdapter implements ChannelAdapter {
  readonly platform = PlatformCode.WechatMp;

  readonly capabilities: AdapterCapabilities = {
    mode: PublishMode.Manual,
    canPublish: false,
    canFetchAnalytics: true,
    canInteract: false,
    supportsSchedule: false,
    maxBodyLength: 20000,
    supportedMedia: ['image'],
  };

  constructor(private readonly context: AdapterContext = {}) {}

  async auth(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    if (!credentials.code) throw new Error('缺少 OAuth code，无法完成公众号授权');
    const response = await requestJson<OauthTokenResponse>(this.context, `${WECHAT_API}/sns/oauth2/access_token`, {
      query: {
        appid: credentials.appId,
        secret: credentials.appSecret,
        code: credentials.code,
        grant_type: 'authorization_code',
      },
    });
    this.assertOk(response.errcode, response.errmsg);
    return {
      ...credentials,
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      openId: response.openid,
      expiresAt: this.expiry(response.expires_in),
    };
  }

  /** Official accounts have no refresh_token flow: the app token is re-issued on demand. */
  async refreshToken(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    return this.issueAppToken(credentials);
  }

  /** Returns the global app token, cached in the token store until shortly before expiry. */
  async issueAppToken(credentials: AdapterCredentials, force = false): Promise<AdapterCredentials> {
    const cacheKey = `wechat_mp:app_token:${credentials.appId}`;
    if (!force) {
      const cached = await this.context.tokenStore?.get(cacheKey);
      if (cached) return { ...credentials, accessToken: cached };
    }

    const response = await requestJson<AppTokenResponse>(this.context, `${WECHAT_API}/cgi-bin/token`, {
      query: { grant_type: 'client_credential', appid: credentials.appId, secret: credentials.appSecret },
    });
    this.assertOk(response.errcode, response.errmsg);
    if (!response.access_token) throw new Error('公众号未返回 access_token');

    const ttl = Math.max((response.expires_in ?? 7200) - TOKEN_SAFETY_WINDOW_SECONDS, 60);
    await this.context.tokenStore?.set(cacheKey, response.access_token, ttl);
    return { ...credentials, accessToken: response.access_token, expiresAt: this.expiry(response.expires_in) };
  }

  async publish(payload: PublishPayload): Promise<PublishResult> {
    return {
      status: 'manual_required',
      message: '公众号禁止 API 自动发布，请手动复制内容到公众号后台发布',
      raw: {
        reason: '《微信公众平台运营规范》3.27 条：不得利用 AI、脚本、接口等自动化方式替代真人完成发布',
        taskId: payload.taskId,
        title: payload.title,
      },
    };
  }

  /**
   * 图文分析：POST /datacube/getarticletotal (single day window, platform limits it to 1 day per call).
   */
  async fetchAnalytics(postId: string, credentials: AdapterCredentials): Promise<AnalyticsSnapshot> {
    const authorised = credentials.accessToken ? credentials : await this.issueAppToken(credentials, true);
    const now = this.context.now?.() ?? new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const response = await requestJson<ArticleTotalResponse>(this.context, `${WECHAT_API}/datacube/getarticletotal`, {
      method: 'POST',
      query: { access_token: authorised.accessToken },
      body: { begin_date: formatDate(yesterday), end_date: formatDate(now) },
    });
    this.assertOk(response.errcode, response.errmsg);

    const item = response.list?.find((entry) => String(entry.msgid ?? '') === postId) ?? response.list?.[0];
    return {
      platform: this.platform,
      postId,
      capturedAt: now.toISOString(),
      metrics: {
        views: item?.int_page_read_count ?? 0,
        likes: item?.like_num ?? 0,
        comments: item?.comment_count ?? 0,
        shares: item?.share_count ?? 0,
        favorites: item?.add_to_fav_count ?? 0,
      },
    };
  }

  private expiry(expiresIn?: number): string | undefined {
    if (!expiresIn) return undefined;
    return new Date((this.context.now?.() ?? new Date()).getTime() + expiresIn * 1000).toISOString();
  }

  private assertOk(errcode?: number, errmsg?: string): void {
    if (errcode !== undefined && errcode !== 0) throw new Error(`公众号接口错误 ${errcode}：${errmsg ?? '未知错误'}`);
  }
}
