import { PlatformCode, PublishMode } from '@mediaflow/shared';

export interface AdapterCredentials {
  appId: string;
  appSecret: string;
  /** Short lived user/app token used by analytics and publish calls. */
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  openId?: string;
  /** OAuth authorization code, only present during the initial exchange. */
  code?: string;
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

export type PublishOutcome = 'published' | 'manual_required' | 'pending' | 'failed';

export interface PublishResult {
  status: PublishOutcome;
  platformPostId?: string;
  platformUrl?: string;
  message: string;
  raw?: Record<string, unknown>;
}

export interface AnalyticsMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
  followers?: number;
}

export interface AnalyticsSnapshot {
  platform: PlatformCode;
  postId: string;
  capturedAt: string;
  metrics: AnalyticsMetrics;
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

/** Cache used for platform tokens; implemented by the API with Redis. */
export interface TokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdapterContext {
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  tokenStore?: TokenStore;
  now?: () => Date;
}

export interface AdapterProfile {
  platformAccountId: string;
  accountName: string;
  avatarUrl?: string;
}

/** Every platform integration must implement this contract. */
export interface ChannelAdapter {
  readonly platform: PlatformCode;
  readonly capabilities: AdapterCapabilities;

  auth(credentials: AdapterCredentials): Promise<AdapterCredentials>;
  refreshToken(credentials: AdapterCredentials): Promise<AdapterCredentials>;
  publish(payload: PublishPayload, credentials: AdapterCredentials): Promise<PublishResult>;
  fetchAnalytics(postId: string, credentials: AdapterCredentials): Promise<AnalyticsSnapshot>;

  /** Platforms with an OAuth flow expose the authorize URL so the UI can offer「去授权」. */
  buildAuthorizeUrl?(appId: string, redirectUri: string, state: string): string;
  /** Reads the bound account profile right after the code exchange. */
  fetchProfile?(credentials: AdapterCredentials): Promise<AdapterProfile>;
}
