import { PlatformCode, PublishMode } from '@mediaflow/shared';
import { requestJson } from '../http';
import {
  AdapterCapabilities,
  AdapterProfile,
  AdapterContext,
  AdapterCredentials,
  AnalyticsSnapshot,
  ChannelAdapter,
  PublishPayload,
  PublishResult,
} from '../types';

const DOUYIN_API = 'https://open.douyin.com';

interface TokenEnvelope<T> {
  data?: T;
  message?: string;
}

interface TokenData {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  open_id?: string;
  scope?: string;
  error_code?: number;
  description?: string;
}

interface ItemData {
  item_id?: string;
  error_code?: number;
  description?: string;
}

interface VideoCreateBody {
  video_id: string;
  text: string;
}

interface UploadData {
  video?: { video_id?: string };
  error_code?: number;
  description?: string;
}

/**
 * Douyin publishes through the official API only. Interactive APIs (DM / comments)
 * were revoked, therefore canInteract is always false.
 */
export class DouyinAdapter implements ChannelAdapter {
  readonly platform = PlatformCode.Douyin;

  readonly capabilities: AdapterCapabilities = {
    mode: PublishMode.Api,
    canPublish: true,
    canFetchAnalytics: true,
    canInteract: false,
    supportsSchedule: true,
    maxBodyLength: 2000,
    supportedMedia: ['video'],
  };

  constructor(private readonly context: AdapterContext = {}) {}

  buildAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
    const query = new URLSearchParams({
      client_key: appId,
      response_type: 'code',
      scope: 'user_info,video.create',
      redirect_uri: redirectUri,
      state,
    });
    return `${DOUYIN_API}/platform/oauth/connect/?${query.toString()}`;
  }

  async fetchProfile(credentials: AdapterCredentials): Promise<AdapterProfile> {
    if (!credentials.accessToken || !credentials.openId) throw new Error('缺少 access_token 或 open_id，无法获取抖音账号资料');
    const response = await requestJson<TokenEnvelope<{ data?: { nickname?: string; avatar?: string }; description?: string }>>(
      this.context,
      `${DOUYIN_API}/oauth/userinfo/`,
      { query: { open_id: credentials.openId, access_token: credentials.accessToken } },
    );
    const data = (response.data as { data?: { nickname?: string; avatar?: string } } | undefined)?.data;
    return {
      platformAccountId: credentials.openId,
      accountName: data?.nickname ?? '抖音账号',
      avatarUrl: data?.avatar,
    };
  }

  async auth(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    if (!credentials.code) throw new Error('缺少 OAuth code，无法完成抖音授权');
    const response = await requestJson<TokenEnvelope<TokenData>>(this.context, `${DOUYIN_API}/oauth/access_token/`, {
      method: 'POST',
      query: {
        client_key: credentials.appId,
        client_secret: credentials.appSecret,
        code: credentials.code,
        grant_type: 'authorization_code',
      },
    });
    return this.toCredentials(credentials, response);
  }

  async refreshToken(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    if (!credentials.refreshToken) throw new Error('缺少 refresh_token，无法刷新抖音令牌');
    const response = await requestJson<TokenEnvelope<TokenData>>(this.context, `${DOUYIN_API}/oauth/refresh_token/`, {
      method: 'POST',
      query: {
        client_key: credentials.appId,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
      },
    });
    return this.toCredentials(credentials, response);
  }

  async publish(payload: PublishPayload, credentials: AdapterCredentials): Promise<PublishResult> {
    if (!credentials.accessToken || !credentials.openId) {
      return {
        status: 'failed',
        message: '未绑定抖音账号或 access_token 缺失，请先在账号管理中完成 OAuth 授权',
      };
    }
    const videoUrl = payload.mediaUrls.find((url) => url.toLowerCase().endsWith('.mp4'));
    if (!videoUrl) {
      return { status: 'failed', message: '抖音仅支持视频发布，请先上传视频素材' };
    }

    // Step 1: hand the video to Douyin, which returns a video_id usable by the publish API.
    const uploaded = await requestJson<TokenEnvelope<UploadData>>(this.context, `${DOUYIN_API}/video/upload/`, {
      method: 'POST',
      query: { open_id: credentials.openId, access_token: credentials.accessToken },
      body: { video_url: videoUrl },
    });
    const videoId = uploaded.data?.video?.video_id;
    if (!videoId) {
      return { status: 'failed', message: `视频上传失败：${uploaded.data?.description ?? uploaded.message ?? '未知原因'}` };
    }

    // Step 2: create the item.
    const created = await requestJson<TokenEnvelope<ItemData>>(this.context, `${DOUYIN_API}/video/create/`, {
      method: 'POST',
      query: { open_id: credentials.openId, access_token: credentials.accessToken },
      body: {
        video_id: videoId,
        text: [payload.title, payload.body, ...payload.tags.map((tag) => `#${tag}`)].filter(Boolean).join('\n'),
      } satisfies VideoCreateBody,
    });
    const itemId = created.data?.item_id;
    if (!itemId) {
      return { status: 'failed', message: `发布失败：${created.data?.description ?? created.message ?? '未知原因'}` };
    }
    return {
      status: 'published',
      platformPostId: itemId,
      platformUrl: `https://www.douyin.com/video/${itemId}`,
      message: '抖音发布成功',
    };
  }

  async fetchAnalytics(postId: string, credentials: AdapterCredentials): Promise<AnalyticsSnapshot> {
    if (!credentials.accessToken || !credentials.openId) throw new Error('未绑定抖音账号，无法获取数据');
    const response = await requestJson<
      TokenEnvelope<{ statistics?: { play_count?: number; digg_count?: number; comment_count?: number; share_count?: number; forward_count?: number }; error_code?: number; description?: string }>
    >(this.context, `${DOUYIN_API}/video/data/`, {
      method: 'POST',
      query: { open_id: credentials.openId, access_token: credentials.accessToken },
      body: { item_ids: [postId] },
    });
    const stats = response.data?.statistics;
    return {
      platform: this.platform,
      postId,
      capturedAt: (this.context.now?.() ?? new Date()).toISOString(),
      metrics: {
        views: stats?.play_count ?? 0,
        likes: stats?.digg_count ?? 0,
        comments: stats?.comment_count ?? 0,
        shares: stats?.share_count ?? 0,
        favorites: stats?.forward_count ?? 0,
      },
    };
  }

  private toCredentials(credentials: AdapterCredentials, response: TokenEnvelope<TokenData>): AdapterCredentials {
    const data = response.data;
    if (!data?.access_token) {
      throw new Error(`抖音授权失败：${data?.description ?? response.message ?? '未知原因'}`);
    }
    const now = this.context.now?.() ?? new Date();
    return {
      ...credentials,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? credentials.refreshToken,
      openId: data.open_id ?? credentials.openId,
      expiresAt: data.expires_in ? new Date(now.getTime() + data.expires_in * 1000).toISOString() : undefined,
    };
  }
}
