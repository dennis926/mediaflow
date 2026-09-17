// Single source of truth lives in @mediaflow/shared so web and h5 stay in sync.
export type {
  AdapterDescriptorDto as AdapterDescriptor,
  AuthUserDto as AuthUser,
  ContentDto as Content,
  ContentVariantDto as ContentVariant,
  LoginResultDto as LoginResult,
  Paged,
  PaginationMeta,
  PublishTaskDto as PublishTask,
  QueueStatsDto as QueueStats,
} from '@mediaflow/shared';

export interface AiGeneration {
  id: string;
  provider: string;
  model: string;
  taskType: string;
  status: string;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number;
  createdAt: string;
}

export interface ComplianceReport {
  passed: boolean;
  score: number;
  violations: Array<{ term: string; category: string; reason: string; suggestion: string }>;
  aiReview?: string;
}

export interface AdaptResult {
  contentId: string;
  generationId: string;
  model: string;
  variants: import('@mediaflow/shared').ContentVariantDto[];
  skipped: import('@mediaflow/shared').PlatformCode[];
}

export interface SettingView {
  key: string;
  label: string;
  description: string;
  secret: boolean;
  group: 'ai' | 'platform' | 'publish';
  groupLabel: string;
  value: string;
  configured: boolean;
  source: 'db' | 'env' | 'none';
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface SettingGroupView {
  group: 'ai' | 'platform' | 'publish';
  label: string;
  items: SettingView[];
}

export interface AiTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  level: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  status: 'unread' | 'read';
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationItem[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  unread: number;
}

export interface CalendarDay {
  date: string;
  tasks: import('@mediaflow/shared').PublishTaskDto[];
}

export interface OverviewData {
  contents: number;
  tasks: number;
  published: number;
  pending: number;
  manualRequired: number;
  failed: number;
  aiGenerated: number;
  publishedLast7Days: number;
  platformBreakdown: Array<{ platform: import('@mediaflow/shared').PlatformCode; total: number; published: number }>;
}

export interface TrendPointData {
  date: string;
  published: number;
  failed: number;
  views: number;
  likes: number;
}

export interface AccountView {
  id: string;
  platform: import('@mediaflow/shared').PlatformCode;
  platformName: string;
  publishMode: import('@mediaflow/shared').PublishMode;
  accountName: string;
  platformAccountId: string;
  avatarUrl: string | null;
  status: string;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface AccountRankingRow {
  socialAccountId: string;
  accountName: string;
  platform: import('@mediaflow/shared').PlatformCode;
  published: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}
