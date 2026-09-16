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
