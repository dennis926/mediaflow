import { PlatformCode, PublishMode } from '@mediaflow/shared';
import {
  AdapterCapabilities,
  AdapterCredentials,
  AnalyticsSnapshot,
  ChannelAdapter,
  PublishPayload,
  PublishResult,
} from '../types';

/**
 * Adapter for platforms without a usable publishing API (视频号 / 知乎 / 头条 / 百家号).
 * The browser extension fills the editor; a human presses publish, so the task stays
 * pending until the extension or the operator confirms it.
 */
export class PluginFillAdapter implements ChannelAdapter {
  readonly capabilities: AdapterCapabilities = {
    mode: PublishMode.Plugin,
    canPublish: false,
    canFetchAnalytics: false,
    canInteract: false,
    supportsSchedule: true,
    maxBodyLength: 5000,
    supportedMedia: ['image', 'video'],
  };

  constructor(
    readonly platform: PlatformCode,
    private readonly editorUrl: string,
  ) {}

  async auth(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    // Plugin platforms reuse the operator's browser session instead of OAuth tokens.
    return credentials;
  }

  async refreshToken(credentials: AdapterCredentials): Promise<AdapterCredentials> {
    return credentials;
  }

  async publish(payload: PublishPayload): Promise<PublishResult> {
    return {
      status: 'pending',
      message: '内容已进入插件待填充队列，请在浏览器中确认并手动点击发布',
      raw: { editorUrl: this.editorUrl, taskId: payload.taskId },
    };
  }

  async fetchAnalytics(postId: string): Promise<AnalyticsSnapshot> {
    return {
      platform: this.platform,
      postId,
      capturedAt: new Date().toISOString(),
      metrics: { views: 0, likes: 0, comments: 0, shares: 0, favorites: 0 },
    };
  }
}
