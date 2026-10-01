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
  /** 命中缓存的输入 token */
  tokensCached?: number;
  /** 输出中的推理（思考）token */
  tokensReasoning?: number;
  /** 缓存写入 token（Anthropic 等额外计费） */
  tokensCacheWrite?: number;
  /** 估算花费（元），单价未配置时恒为 0 */
  cost: string;
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
  knowledgeUsed?: KnowledgeMatchItem[];
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

export interface UserItem {
  id: string;
  email: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  status: 'active' | 'disabled';
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  roles: string[];
  lastLoginAt: string | null;
  invitedBy: string | null;
  createdAt: string;
}

export interface RoleItem {
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  memberCount: number;
}

export interface ReviewItem {
  id: string;
  contentId: string;
  contentTitle?: string;
  round: number;
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  comments: string | null;
  checklist: Record<string, boolean>;
  submittedBy: string | null;
  submittedByName: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface KnowledgeItem {
  id: string;
  brand: string;
  category: 'brand' | 'product' | 'ingredient' | 'compliance' | 'faq' | 'tone';
  title: string;
  content: string;
  tags: string[];
  keywords: string[];
  priority: number;
  platforms: string[];
  sourceUrl: string | null;
  isActive: boolean;
  /** 条目由 AI 起草（人工确认后入库）。 */
  aiGenerated: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface KnowledgeMatchItem {
  id: string;
  brand: string;
  category: string;
  title: string;
  content: string;
  matchedBy: string[];
  score: number;
}

export interface ImportChunkPreview {
  index: number;
  title: string;
  content: string;
  charCount: number;
  preview: string;
}

export interface SiteConfigView {
  name: string;
  tagline: string;
  company: string;
  supportEmail: string;
  brandColor: string;
  logoUrl: string;
  /** 列表默认每页条数（可在「设置 → 站点信息」调整） */
  pageSize: number;
  aiDisclosureSuffix: string;
}

export interface WorkspaceSummaryItem {
  id: string;
  name: string;
  slug: string;
  status: string;
  roleCodes: string[];
  isCurrent: boolean;
}

export interface WorkspaceMemberItem {
  userId: string;
  displayName: string;
  email: string;
  roleCodes: string[];
  joinedAt: string;
}

export interface ContentTemplateItem {
  id: string;
  name: string;
  description: string | null;
  platform: string | null;
  category: string | null;
  title: string;
  body: string;
  tags: string[];
  isActive: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  createdByName: string | null;
  updatedAt: string;
}

export interface QueueHealth {
  stream: string;
  group: string;
  length: number;
  pending: number;
  consumers: number;
  workerEnabled: boolean;
  stuckMinutes: number;
  stuckTasks: Array<{
    id: string;
    title: string | null;
    platform: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    lockedBy: string | null;
    lockedAt: string | null;
    lockedMinutes: number;
  }>;
  deadLetters: Array<{
    id: string;
    title: string | null;
    platform: string;
    attempts: number;
    maxAttempts: number;
    errorMessage: string | null;
    finishedAt: string | null;
  }>;
}

export interface ContentRevisionItem {
  id: string;
  contentId: string;
  version: number;
  title: string;
  body: string;
  status: string;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface AuditLogItem {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorId: string | null;
  actorName: string | null;
  ip: string | null;
  userAgent: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ModelPriceCnyView {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelPriceCnyTierView {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ModelPriceCnyTieredView {
  peak: ModelPriceCnyTierView;
  offpeak: ModelPriceCnyTierView;
}

export type PriceTier = 'peak' | 'offpeak';

export interface ModelPricingView {
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  /** 实付价（人民币/百万 token），按当前时段取峰或谷 */
  price: ModelPriceCnyView;
  /** 官方美元价（海外供应商才有） */
  officialUsd: ModelPriceCnyView | null;
  /** 官方人民币价，分峰谷（国内供应商才有） */
  officialCny: ModelPriceCnyTieredView | null;
  /** 当前生效的档位 */
  tier: PriceTier;
  /** 是否分峰谷两档计费 */
  tiered: boolean;
  source: 'override' | 'official' | 'catalog' | 'global';
  configured: boolean;
  reference: boolean;
  note?: string;
}

export interface ProviderPricingView {
  provider: string;
  label: string;
  configured: boolean;
  hasApiKey: boolean;
  baseUrl: string;
  protocol: string;
  /** 是否支持从官网自动抓取价格 */
  scrapable: boolean;
  models: ModelPricingView[];
}

export interface PricingRulesView {
  usdToCny: number;
  description: string;
  tier: PriceTier;
  tierLabel: string;
  peakWindows: string;
  peakConfig: { windows: Array<{ days: number[]; start: string; end: string }>; holidays: string[]; timeZone: string };
  scrapableProviders: string[];
  /** 无法自动抓取的供应商及原因（界面照实说明，不显示成故障） */
  unscrapable: Array<{ provider: string; label: string; url: string; reason: string }>;
}

export interface OfficialPriceProviderSnapshotView {
  /** 最近一次「抓取成功」的时间；从未成功过时为空字符串。 */
  fetchedAt: string;
  sourceUrl: string;
  models: Record<
    string,
    {
      model: string;
      catalogModel?: string;
      version?: string;
      currency: 'CNY' | 'USD';
      peak: ModelPriceCnyTierView;
      offpeak: ModelPriceCnyTierView;
      note?: string;
    }
  >;
  error?: string;
  failedAt?: string;
  consecutiveFailures?: number;
  failures?: Array<{ at: string; message: string }>;
}

export interface OfficialPriceSnapshotView {
  fetchedAt: string;
  sources: Record<string, string>;
  providers: Record<
    string,
    Record<string, { model: string; version?: string; peak: ModelPriceCnyTierView; offpeak: ModelPriceCnyTierView }>
  >;
  detail?: Record<string, OfficialPriceProviderSnapshotView>;
  warnings?: string[];
}

export interface OfficialPriceRefreshResultView {
  fetchedAt: string;
  providers: Array<{
    provider: string;
    sourceUrl: string;
    fetchedAt: string;
    count: number;
    models: Array<{ model: string; currency: 'CNY' | 'USD' }>;
    warning: string | null;
  }>;
  /** 本次抓取失败的供应商及原因（被反爬拦截等），界面照实列出。 */
  failures?: Array<{ provider: string; message: string }>;
  warning: string | null;
}

export interface ProviderConfigItem {
  provider: string;
  label: string;
  baseUrl: string;
  models: string[];
  protocol: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  modelCount: number;
}

export interface AiUsageModelRow extends ModelPricingView {
  calls: number;
  tokens: number;
  cost: string;
}

export interface AiUsageReport {
  range: { days: number; from: string };
  filter: { provider: string | null; model: string | null };
  summary: {
    calls: number;
    failed: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCached: number;
    tokensCacheWrite: number;
    tokensReasoning: number;
    cacheHitRate: number;
    cost: string;
    costRecorded: string;
    avgLatencyMs: number;
    avgCostPerCall: string;
    priceConfigured: boolean;
  };
  costBreakdown: { input: string; output: string; cacheWrite: string; cacheRead: string; total: string };
  pricing: (ModelPricingView & { source: string }) | null;
  byDay: Array<{ date: string; calls: number; tokens: number; cached: number; cost: string }>;
  byTask: Array<{ taskType: string; calls: number; tokens: number; cached: number; cost: string }>;
  byModel: Array<{ provider: string; model: string; calls: number; tokens: number; cost: string }>;
  models: AiUsageModelRow[];
  providers: ProviderPricingView[];
  rules: PricingRulesView;
  note: string | null;
}

export interface AiUsageSummary {
  summary: {
    calls: number;
    failed: number;
    tokensInput: number;
    tokensOutput: number;
    /** 命中提示词缓存的输入 token */
    tokensCached: number;
    /** 输出中的推理（思考）token */
    tokensReasoning: number;
    cacheHitRate: number;
    cost: string;
    costRecorded: string;
    avgLatencyMs: number;
    avgCostPerCall: string;
    priceConfigured: boolean;
  };
  /** 当前生效的三段单价（元/百万 token） */
  pricing: { inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number };
  /** 单价 × 用量 = 金额 的明细 */
  costBreakdown: {
    inputMissed: { tokens: number; unitPrice: number; amount: string };
    inputCached: { tokens: number; unitPrice: number; amount: string };
    output: { tokens: number; unitPrice: number; amount: string };
    total: string;
  };
  byDay: Array<{ date: string; calls: number; tokens: number; cached: number; cost: string }>;
  byTask: Array<{ taskType: string; calls: number; tokens: number; cached: number; cost: string }>;
  byModel: Array<{ model: string; calls: number; tokens: number; cached: number; cost: string }>;
}

export interface MediaAssetItem {
  id: string;
  storedName: string;
  originalName: string;
  mimeType: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  size: string;
  url: string;
  groupName: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

export interface KnowledgeExportFile {
  fileName: string;
  mimeType: string;
  content: string;
}

export interface KnowledgeImportPreview {
  fileName: string;
  format: 'tabular' | 'json' | 'markdown';
  columns: string[];
  mapping: Record<string, string | undefined>;
  unmappedTargets: Array<{ target: string; label: string }>;
  preview: Array<Record<string, string>>;
  rows: Array<Record<string, string>>;
  total: number;
  warnings: string[];
}

export interface KnowledgeImportResult {
  created: number;
  skipped: Array<{ row: number; reason: string }>;
  duplicates: number;
  categoriesApplied: boolean;
}

export interface KnowledgeCategoryView {
  code: string;
  label: string;
  tone: string;
  description?: string;
  /** 该分类下已有多少条资料（用于删除前的提示） */
  count: number;
}

export interface KnowledgeDraft {
  title: string;
  content: string;
  tags: string[];
  keywords: string[];
}

export interface KnowledgeSourceGroup {
  sourceUrl: string;
  fileName: string;
  count: number;
  activeCount: number;
  lastCreatedAt: string;
  ids: string[];
}

export interface KnowledgeAuditIssue {
  id: string;
  title: string;
  brand: string;
  kind: 'too_short' | 'too_long' | 'no_tags' | 'never_used';
  detail: string;
}

export interface KnowledgeAuditReport {
  summary: {
    total: number;
    active: number;
    inactive: number;
    neverUsed: number;
    aiGenerated: number;
    duplicateGroups: number;
    checkedAt: string;
  };
  duplicateGroups: Array<{ similarity: number; items: Array<{ id: string; title: string; brand: string }> }>;
  issues: KnowledgeAuditIssue[];
}

export interface ParsedChunk {
  index: number;
  title: string;
  content: string;
  charCount: number;
  /** 该片来自本地 OCR（图片/扫描件），复核时需重点核对。 */
  fromOcr: boolean;
}

export interface ParseResult {
  parsed: { fileName: string; fileType: string; charCount: number; warnings: string[]; ocrSections?: number };
  tempFile: string;
  chunks: ParsedChunk[];
}

export interface CommitImportResult {
  created: Array<{ id: string; title: string; isActive: boolean }>;
  storedPath: string | null;
}

export interface ImportResult {
  parsed: { fileName: string; fileType: string; charCount: number; warnings: string[]; ocrSections?: number };
  storedPath: string;
  chunks: ImportChunkPreview[];
  created: Array<{ id: string; title: string; isActive: boolean }>;
}

/** 当前用户在当前工作区生效的能力点（GET /auth/capabilities，只读自己） */
export interface CapabilitiesView {
  workspaceId: string;
  role: string | null;
  roles: string[];
  capabilities: string[];
  workspaceStatus: string;
  isSuperAdmin: boolean;
}

/** 工作区生命周期状态（归档 → 软删 → 恢复；daysUntilPurge 由后端算好） */
export interface WorkspaceStatusView {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'archived' | 'soft_deleted';
  archivedAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  daysUntilPurge: number | null;
}

/** 永久清除前的影响面预估（逐表行数 + 文件数） */
export interface WorkspacePurgePreview {
  rows: Record<string, number>;
  files: number;
}

/** 导出任务（ZIP 产物保留 7 天；下载需另申请 15 分钟一次性链接） */
export interface WorkspaceExportJobItem {
  id: string;
  status: string;
  progress: number;
  sizeBytes: number | null;
  checksum: string | null;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
  downloadEndpoint?: string;
}
