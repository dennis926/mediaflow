import { PlatformCode, PublishMode } from '@mediaflow/shared';

export interface AdapterCredentials {
  appId: string;
  appSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface PublishPayload {
  taskId: string;
  title: string;
  body: string;
  tags: string[];
  mediaUrls: string[];
  coverUrl?: string;
  scheduledAt?: string;
  aiGenerated: boolean;
}

export interface PublishResult {
  status: 'published' | 'manual_required' | 'pending' | 'failed';
  platformPostId?: string;
  platformUrl?: string;
  message: string;
  raw?: Record<string, unknown>;
}

export interface AnalyticsSnapshot {
  platform: PlatformCode;
  postId: string;
  capturedAt: string;
  metrics: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    favorites: number;
    followers?: number;
  };
}

export interface AdapterCapabilities {
  mode: PublishMode;
  canPublish: boolean;
  canFetchAnalytics: boolean;
  canInteract: boolean;
  supportsSchedule: boolean;
  maxBodyLength: number;
  supportedMedia: Array<'image' | 'video' | 'audio'>;
}

/** Every platform integration must implement this contract. */
export interface ChannelAdapter {
  readonly platform: PlatformCode;
  readonly capabilities: AdapterCapabilities;

  auth(credentials: AdapterCredentials): Promise<AdapterCredentials>;
  refreshToken(credentials: AdapterCredentials): Promise<AdapterCredentials>;
  publish(payload: PublishPayload, credentials: AdapterCredentials): Promise<PublishResult>;
  fetchAnalytics(postId: string, credentials: AdapterCredentials): Promise<AnalyticsSnapshot>;
}
