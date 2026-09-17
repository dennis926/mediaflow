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

interface NotePublishResponse {
  data?: { note_id?: string; success?: boolean };
  success?: boolean;
  code?: number;
  msg?: string;
}

interface NoteDetailResponse {
  data?: {
    note_id?: string;
    view_count?: number;
    liked_count?: number;
    comment_count?: number;
    collect_count?: number;
    share_count?: number;
  };
  code?: number;
  msg?: string;
}

export class XiaohongshuAdapter implements ChannelAdapter {
  readonly platform = PlatformCode.Xiaohongshu;

  readonly capabilities: AdapterCapabilities = {
    mode: PublishMode.Api,
    canPublish: true,
    canFetchAnalytics: true,
    canInteract: false,
    supportsSchedule: true,
    maxBodyLength: 1000,
    supportedMedia: ['image', 'video'],
  };

  /**
   * The open platform base url must be provided by configuration: it differs between the
   * sandbox and production tenants and has to be confirmed against the partner docs.
   */
  constructor(
    private readonly context: AdapterContext = {},
    private readonly baseUrl?: string,
  ) {}

  buildAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
    const query = new URLSearchParams({ app_id: appId, redirect_uri: redirectUri, response_type: 'code', state });
    return `${this.requireBaseUrl()}/api/v1/oauth/authorize?${query.toString()}`;
  }

  async fetchProfile(credentials: AdapterCredentials): Promise<AdapterProfile> {
    if (!credentials.accessToken) throw new Error('缺少 access_token，无法获取小红书账号资料');
    const response = await requestJson<{ data?: { user_id?: string; nickname?: string; avatar?: string }; msg?: string }>(
      this.context,
      `${this.requireBaseUrl()}/api/v1/user/info`,
      { method: 'POST', body: { access_token: credentials.accessToken } },
    );
    const data = response.data;
    return {
      platformAccountId: data?.user_id ?? 'unknown',
      accountName: data?.nickname ?? '小红书账号',
      avatarUrl: data?.avatar,
    };
  }

  async auth(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    if (!credentials.code) throw new Error('缺少 OAuth code，无法完成小红书授权');
    const response = await requestJson<{ data?: { access_token?: string; refresh_token?: string; expires_in?: number }; msg?: string }>(
      this.context,
      `${this.requireBaseUrl()}/api/v1/oauth/token`,
      {
        method: 'POST',
        body: {
          app_id: credentials.appId,
          app_secret: credentials.appSecret,
          code: credentials.code,
          grant_type: 'authorization_code',
        },
      },
    );
    const data = response.data;
    if (!data?.access_token) throw new Error(`小红书授权失败：${response.msg ?? '未知原因'}`);
    return {
      ...credentials,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      // access_token expires in ~2h, refresh_token in ~7d.
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    };
  }

  async refreshToken(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    if (!credentials.refreshToken) throw new Error('缺少 refresh_token，无法刷新小红书令牌');
    const response = await requestJson<{ data?: { access_token?: string; refresh_token?: string; expires_in?: number }; msg?: string }>(
      this.context,
      `${this.requireBaseUrl()}/api/v1/oauth/refresh`,
      { method: 'POST', body: { app_id: credentials.appId, refresh_token: credentials.refreshToken, grant_type: 'refresh_token' } },
    );
    const data = response.data;
    if (!data?.access_token) throw new Error(`小红书令牌刷新失败：${response.msg ?? '未知原因'}`);
    return {
      ...credentials,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? credentials.refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    };
  }

  async publish(payload: PublishPayload, credentials: AdapterCredentials): Promise<PublishResult> {
    if (!credentials.accessToken) {
      return { status: 'failed', message: '未绑定小红书账号或 access_token 缺失，请先在账号管理中完成授权' };
    }
    if (!this.baseUrl) {
      return { status: 'failed', message: '未配置小红书开放平台 API 地址（XIAOHONGSHU_API_BASE），无法调用发布接口' };
    }

    const response = await requestJson<NotePublishResponse>(this.context, `${this.baseUrl}/api/v1/note/publish`, {
      method: 'POST',
      body: {
        title: payload.title,
        desc: [payload.body, ...payload.tags.map((tag) => `#${tag}`)].filter(Boolean).join(' '),
        // Media must be uploaded to the platform CDN first; file ids are passed here.
        file_ids: payload.mediaUrls,
        cover: payload.coverUrl,
        type: payload.mediaUrls.some((url) => url.toLowerCase().endsWith('.mp4')) ? 'video' : 'normal',
      },
    });
    const noteId = response.data?.note_id;
    if (!noteId) {
      return { status: 'failed', message: `小红书发布失败：${response.msg ?? '未返回 note_id'}` };
    }
    return {
      status: 'published',
      platformPostId: noteId,
      platformUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
      message: '小红书发布成功',
    };
  }

  async fetchAnalytics(postId: string, credentials: AdapterCredentials): Promise<AnalyticsSnapshot> {
    if (!credentials.accessToken) throw new Error('未绑定小红书账号，无法获取数据');
    const response = await requestJson<NoteDetailResponse>(this.context, `${this.requireBaseUrl()}/api/v1/note/detail`, {
      method: 'POST',
      body: { note_id: postId },
    });
    const data = response.data;
    return {
      platform: this.platform,
      postId,
      capturedAt: (this.context.now?.() ?? new Date()).toISOString(),
      metrics: {
        views: data?.view_count ?? 0,
        likes: data?.liked_count ?? 0,
        comments: data?.comment_count ?? 0,
        shares: data?.share_count ?? 0,
        favorites: data?.collect_count ?? 0,
      },
    };
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl) throw new Error('未配置小红书开放平台 API 地址（XIAOHONGSHU_API_BASE）');
    return this.baseUrl;
  }
}
