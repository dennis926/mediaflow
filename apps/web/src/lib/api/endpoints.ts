import type { AiFlagType, ContentStatus, PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import { api, apiUpload } from './client';
import type {
  AccountRankingRow,
  AccountView,
  AdaptResult,
  AdapterDescriptor,
  AiGeneration,
  AiTestResult,
  AiUsageReport,
  AiUsageSummary,
  AuditLogItem,
  AuthUser,
  CalendarDay,
  CapabilitiesView,
  CommitImportResult,
  ComplianceReport,
  Content,
  ContentRevisionItem,
  ContentTemplateItem,
  ContentVariant,
  ImportResult,
  KnowledgeAuditReport,
  KnowledgeCategoryView,
  KnowledgeDraft,
  KnowledgeExportFile,
  KnowledgeImportPreview,
  KnowledgeImportResult,
  KnowledgeItem,
  KnowledgeMatchItem,
  KnowledgeSourceGroup,
  LoginResult,
  MediaAssetItem,
  ModelPriceCnyView,
  NotificationItem,
  NotificationPage,
  OverviewData,
  Paged,
  ParseResult,
  ModelPriceCnyTierView,
  OfficialPriceSnapshotView,
  PricingRulesView,
  ProviderConfigItem,
  ProviderPricingView,
  PublishTask,
  QueueHealth,
  QueueStats,
  ReviewItem,
  RoleItem,
  SettingGroupView,
  SiteConfigView,
  TrendPointData,
  UserItem,
  WorkspaceExportJobItem,
  WorkspaceMemberItem,
  WorkspacePurgePreview,
  WorkspaceStatusView,
  WorkspaceSummaryItem,
} from './types';




export const usersApi = {
  list: (query: { keyword?: string; status?: string; role?: string; page?: number; pageSize?: number }) =>
    api.get<Paged<UserItem>>('/users', { ...query }),
  roles: () => api.get<RoleItem[]>('/users/roles'),
  create: (payload: { email: string; displayName: string; phone?: string; roleCodes?: string[] }) =>
    api.post<{ user: UserItem; tempPassword: string | null }>('/users', payload),
  invite: (payload: { email: string; displayName: string; roleCodes?: string[] }) =>
    api.post<{ user: UserItem; tempPassword: string }>('/users/invite', payload),
  update: (id: string, payload: { displayName?: string; phone?: string; avatarUrl?: string }) =>
    api.put<UserItem>(`/users/${id}`, payload),
  remove: (id: string) => api.delete<{ id: string }>(`/users/${id}`),
  updateRoles: (id: string, roleCodes: string[]) => api.patch<UserItem>(`/users/${id}/roles`, { roleCodes }),
  resetPassword: (id: string) => api.patch<{ success: true; tempPassword: string | null }>(`/users/${id}/reset-password`, {}),
  updateStatus: (id: string, status: 'active' | 'disabled') => api.patch<UserItem>(`/users/${id}/status`, { status }),
};

export const reviewsApi = {
  list: (query: { status?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<ReviewItem> & { pendingCount: number }>('/reviews', { ...query }),
  detail: (id: string) => api.get<ReviewItem>(`/reviews/${id}`),
  history: (contentId: string) => api.get<ReviewItem[]>(`/reviews/history/${contentId}`),
  submit: (contentId: string, comments?: string) => api.post<ReviewItem>('/reviews/submit', { contentId, comments }),
  decide: (id: string, payload: { decision: 'approved' | 'rejected' | 'changes_requested'; comments?: string; checklist?: Record<string, boolean> }) =>
    api.put<ReviewItem>(`/reviews/${id}`, payload),
  checklist: () => api.get<{ labels: Record<string, string> }>('/reviews/checklist'),
};

export const authApi = {
  login: (email: string, password: string) => api.post<LoginResult>('/auth/login', { email, password }),
  me: () => api.get<AuthUser>('/auth/me'),
  /** 切换工作区：服务端重新签发令牌 */
  switchWorkspace: (workspaceId: string) =>
    api.post<{ accessToken: string; refreshToken: string; expiresIn: string; user: AuthUser }>('/auth/switch-workspace', { workspaceId }),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ success: true }>('/auth/change-password', { currentPassword, newPassword }),
  /** 登出：服务端把刷新令牌加入黑名单（幂等）；失败也不影响本地清除登录态 */
  logout: (refreshToken?: string) => api.post<{ ok: true }>('/auth/logout', { refreshToken }),
  /** 自己的能力点（前端据此显示/隐藏按钮，不硬编码角色） */
  capabilities: () => api.get<CapabilitiesView>('/auth/capabilities'),
};

export interface ContentQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: ContentStatus;
  platform?: PlatformCode;
  aiGenerated?: boolean;
}

export interface ContentPayload {
  title: string;
  summary?: string;
  body: string;
  tags?: string[];
  coverUrl?: string;
  status?: ContentStatus;
  aiFlagType?: AiFlagType;
}

export const contentApi = {
  list: (query: ContentQuery) => api.get<Paged<Content>>('/contents', { ...query }),
  get: (id: string) => api.get<Content>(`/contents/${id}`),
  create: (payload: ContentPayload) => api.post<Content>('/contents', payload),
  update: (id: string, payload: Partial<ContentPayload>) => api.put<Content>(`/contents/${id}`, payload),
  remove: (id: string) => api.delete<{ id: string; deletedAt: string }>(`/contents/${id}`),
  /** 归档 / 取消归档：保留历史，不再参与发布与检索 */
  archive: (id: string, archived: boolean) => api.patch<Content>(`/contents/${id}/archive`, { archived }),
  variants: (id: string) => api.get<ContentVariant[]>(`/contents/${id}/variants`),
  aiAdapt: (id: string, payload: { platforms: PlatformCode[]; tone?: string; keywords?: string[]; overwrite?: boolean }) =>
    api.post<AdaptResult>(`/contents/${id}/ai-adapt`, payload),
  /** 批量归档/取消归档/删除（逐条返回失败原因） */
  batch: (ids: string[], action: 'archive' | 'unarchive' | 'delete') =>
    api.post<{ affected: number; failed: Array<{ id: string; reason: string }> }>('/contents/batch', { ids, action }),
  /** 版本历史（新到旧） */
  revisions: (id: string) => api.get<ContentRevisionItem[]>(`/contents/${id}/revisions`),
  /** 回滚到指定版本 */
  restoreRevision: (id: string, revisionId: string) => api.post<Content>(`/contents/${id}/revisions/${revisionId}/restore`, {}),
  aiFlagCheck: (id: string, checked: boolean, note?: string) =>
    api.patch<Content>(`/contents/${id}/ai-flag-check`, { checked, note }),
};

export interface PublishTaskQuery {
  page?: number;
  pageSize?: number;
  status?: PublishTaskStatus;
  platform?: PlatformCode;
}

export const publishApi = {
  tasks: (query: PublishTaskQuery) => api.get<Paged<PublishTask>>('/publish/tasks', { ...query }),
  task: (id: string) => api.get<PublishTask>(`/publish/tasks/${id}`),
  create: (payload: { contentId: string; platforms: PlatformCode[]; scheduledAt?: string }) =>
    api.post<PublishTask[]>('/publish/tasks', payload),
  adapters: () => api.get<AdapterDescriptor[]>('/publish/adapters'),
  retry: (id: string) => api.post<PublishTask>(`/publish/tasks/${id}/retry`),
  cancel: (id: string) => api.delete<PublishTask>(`/publish/tasks/${id}`),
  /** 批量取消/重试 */
  batch: (ids: string[], action: 'cancel' | 'retry') =>
    api.post<{ affected: number; failed: Array<{ id: string; reason: string }> }>('/publish/tasks/batch', { ids, action }),
  calendar: (weekStart?: string) => api.get<CalendarDay[]>('/publish/calendar', { weekStart }),
  queueStats: () => api.get<QueueStats>('/publish/queue/stats'),
  /** 队列运维视图：卡住任务与死信 */
  queueHealth: () => api.get<QueueHealth>('/publish/queue/health'),
  /** 强制重排（无视锁定状态） */
  requeue: (id: string) => api.post<PublishTask>(`/publish/tasks/${id}/requeue`),
  /**
   * 人工发布完成回填：公众号按平台规则禁止 API 发布，视频号/知乎等靠插件填充 + 人工确认，
   * 这些任务发完之后必须能回填结果，否则会永远停在"待人工发布"。
   */
  markManualPublished: (id: string, payload: { url?: string; postId?: string; note?: string }) =>
    api.post<PublishTask>(`/publish/tasks/${id}/manual-published`, payload),
  /** 人工发布失败回填（原因必填） */
  markManualFailed: (id: string, payload: { reason: string }) =>
    api.post<PublishTask>(`/publish/tasks/${id}/manual-failed`, payload),
};

export const aiApi = {
  status: () => api.get<{ provider: string; model: string }>('/ai/status'),
  optimizeTitle: (payload: { title: string; platform?: PlatformCode; keywords?: string[] }) =>
    api.post<{ titles: string[]; generationId: string }>('/ai/optimize-title', payload),
  complianceCheck: (payload: { text: string; platform?: PlatformCode; useAiReview?: boolean }) =>
    api.post<ComplianceReport>('/ai/compliance-check', payload),
  usage: (days = 14) => api.get<AiUsageSummary>('/ai/usage', { days }),
  /** 用量报告（可按供应商 + 模型筛选） */
  usageReport: (days = 14, filter: { provider?: string; model?: string } = {}) =>
    api.get<AiUsageReport>('/ai/usage', { days, provider: filter.provider, model: filter.model }),
  /** 供应商与模型价目 */
  providers: (onlyConfigured = false) => api.get<ProviderPricingView[]>('/ai/providers', { onlyConfigured }),
  providerConfigs: () => api.get<ProviderConfigItem[]>('/ai/provider-configs'),
  upsertProvider: (payload: Partial<ProviderConfigItem> & { provider: string; apiKey?: string }) =>
    api.put<ProviderConfigItem[]>('/ai/provider-configs', payload),
  removeProvider: (provider: string) => api.delete<ProviderConfigItem[]>(`/ai/provider-configs/${provider}`),
  catalog: () =>
    api.get<{ providers: Array<{ provider: string; label: string; defaultBaseUrl: string }>; models: Array<{ provider: string; label: string; defaultBaseUrl: string; protocol: string; models: Array<{ model: string; label: string; officialUsd: ModelPriceCnyView }> }> }>('/ai/catalog'),
  /** 覆盖单个模型的实付价（元/百万 token） */
  setModelPrice: (payload: { provider: string; model: string; price: ModelPriceCnyView }) =>
    api.put<{ ok: true }>('/ai/model-price', payload),
  /** 删除覆盖价，恢复「官方美元价 × 汇率」 */
  clearModelPrice: (provider: string, model: string) => api.delete<{ ok: true }>('/ai/model-price', { provider, model }),
  pricingRules: () => api.get<PricingRulesView>('/ai/pricing-rules'),
  /** 官网价格快照（最近一次抓取的时间、来源与各模型峰谷价） */
  officialPrices: () => api.get<OfficialPriceSnapshotView | null>('/ai/official-prices'),
  /** 立即抓取供应商官网价格 */
  refreshOfficialPrices: (provider = 'deepseek') =>
    api.post<{
      provider: string;
      sourceUrl: string;
      fetchedAt: string;
      models: Array<{ model: string; version?: string; peak: ModelPriceCnyTierView; offpeak: ModelPriceCnyTierView }>;
      warning: string | null;
    }>('/ai/official-prices/refresh', { provider }),
  generations: (query: { page?: number; pageSize?: number; taskType?: string }) =>
    api.get<Paged<AiGeneration>>('/ai/generations', { ...query }),
};

export const settingsApi = {
  list: () => api.get<SettingGroupView[]>('/settings'),
  update: (items: Array<{ key: string; value: string }>) => api.put<SettingGroupView[]>('/settings', { items }),
  testAi: (payload: { apiKey?: string; model?: string; baseUrl?: string }) =>
    api.post<AiTestResult>('/settings/ai/test', payload),
};

export const notificationsApi = {
  list: (query: { page?: number; pageSize?: number; status?: 'unread' | 'read' } = {}) =>
    api.get<NotificationPage>('/notifications', { ...query }),
  markRead: (id: string) => api.patch<NotificationItem>(`/notifications/${id}/read`),
  markAllRead: () => api.post<{ updated: number }>('/notifications/read-all'),
};

export const analyticsApi = {
  overview: () => api.get<OverviewData>('/analytics/overview'),
  trend: (days = 14) => api.get<TrendPointData[]>('/analytics/trend', { days }),
  ranking: () => api.get<AccountRankingRow[]>('/analytics/accounts/ranking'),
  /**
   * 手动录入平台指标（无平台 API 时的取数路径之一；另一条是浏览器插件自动回收）。
   * 成员看平台后台的数字后录进来，数据中心就不会一直是空的。
   */
  manualMetrics: (payload: {
    platform: string;
    contentId?: string;
    socialAccountId?: string;
    postId?: string;
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    favorites?: number;
    capturedAt?: string;
    note?: string;
  }) => api.post<{ id: string }>('/analytics/manual-metrics', payload),
  sync: (payload: { contentId?: string; limit?: number } = {}) =>
    api.post<{ synced: number; failed: number; results: Array<{ taskId: string; platform: string; ok: boolean; message: string }> }>(
      '/analytics/sync',
      payload,
    ),
};

export interface OAuthAuthorizeResult {
  platform: string;
  authorizeUrl: string;
  state: string;
  redirectUri: string;
}

export const accountsApi = {
  /** Returns the platform authorize URL to open (needs the AppID configured in 系统设置). */
  oauthAuthorize: (platform: string) => api.get<OAuthAuthorizeResult>(`/accounts/oauth/${platform}/authorize`),
  list: (platform?: string) => api.get<AccountView[]>('/accounts', { platform }),
  /**
   * 手动登记账号（无需 OAuth 资质/密钥）：只记元信息，不保存 token。
   * 适合"先跑起来"的场景——发布走浏览器插件填充或人工确认，之后再补正式授权。
   */
  registerManual: (payload: { platform: string; accountName: string; platformAccountId?: string; homepage?: string; note?: string }) =>
    api.post<AccountView>('/accounts/manual', payload),
  bind: (payload: {
    platform: string;
    accountName: string;
    platformAccountId: string;
    avatarUrl?: string;
    accessToken?: string;
    refreshToken?: string;
    extra?: Record<string, unknown>;
  }) => api.post<AccountView>('/accounts/bind', payload),
  unbind: (id: string) => api.delete<{ id: string }>(`/accounts/${id}`),
};

/** 站点信息（未登录可读）：登录页、侧边栏、浏览器标题都用它 */
export const publicApi = {
  siteConfig: () => api.get<SiteConfigView>('/public/site-config'),
};

/** 工作区：同一实例里可以放多个业务空间，数据按工作区隔离 */
export const workspacesApi = {
  mine: () => api.get<WorkspaceSummaryItem[]>('/workspaces'),
  create: (payload: { name: string; slug?: string }) => api.post<WorkspaceSummaryItem>('/workspaces', payload),
  members: (id: string) => api.get<WorkspaceMemberItem[]>(`/workspaces/${id}/members`),
  upsertMember: (id: string, payload: { userId: string; roleCodes: string[] }) =>
    api.put<WorkspaceMemberItem>(`/workspaces/${id}/members`, payload),
  removeMember: (id: string, userId: string) => api.delete<{ userId: string }>(`/workspaces/${id}/members/${userId}`),

  // ---------- 生命周期（归档 → 软删 → 恢复）与导出（B0.4） ----------
  status: (id: string) => api.get<WorkspaceStatusView>(`/workspaces/${id}/status`),
  archive: (id: string) => api.post<WorkspaceStatusView>(`/workspaces/${id}/archive`, {}),
  unarchive: (id: string) => api.post<WorkspaceStatusView>(`/workspaces/${id}/unarchive`, {}),
  /** 删除是软删除：保留期内可恢复；confirmName 必须是工作区完整名称 */
  softDelete: (id: string, payload: { confirmName: string; confirmLastWorkspace?: boolean; reason?: string }) =>
    api.deleteWithBody<WorkspaceStatusView>(`/workspaces/${id}`, payload),
  restore: (id: string) => api.post<WorkspaceStatusView>(`/workspaces/${id}/restore`, {}),
  /** 永久清除前的影响面（清除动作本身不在界面提供，只走运维手册） */
  purgePreview: (id: string) => api.get<WorkspacePurgePreview>(`/workspaces/${id}/purge-preview`),
  requestExport: (id: string) => api.post<WorkspaceExportJobItem>(`/workspaces/${id}/export`, {}),
  exportJob: (id: string, jobId: string) => api.get<WorkspaceExportJobItem>(`/workspaces/${id}/export/${jobId}`),
  exportLink: (id: string, jobId: string) =>
    api.post<{ url: string; expiresAt: string }>(`/workspaces/${id}/export/${jobId}/link`, {}),
};

/** 审计日志：谁在什么时候改了什么 */
export const auditApi = {
  list: (query: { action?: string; actionPrefix?: string; actor?: string; keyword?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<AuditLogItem>>('/audit-logs', { ...query }),
  actions: (days = 90) => api.get<Array<{ action: string; count: number }>>('/audit-logs/actions', { days }),
};

/** 素材库：图片/视频上传与选择（发布到平台必需） */
export const mediaApi = {
  list: (query: { kind?: string; keyword?: string; group?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<MediaAssetItem>>('/media', { ...query }),
  groups: () => api.get<Array<{ group: string; count: number }>>('/media/groups'),
  upload: (file: File, groupName?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (groupName) form.append('groupName', groupName);
    return apiUpload<MediaAssetItem>('/media', form);
  },
  remove: (id: string) => api.delete<{ id: string }>(`/media/${id}`),
};

/** 文案模板库：常用写法沉淀与一键套用 */
export const templatesApi = {
  list: (query: { keyword?: string; platform?: string; category?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<ContentTemplateItem>>('/content-templates', { ...query }),
  categories: () => api.get<Array<{ category: string; count: number }>>('/content-templates/categories'),
  create: (payload: Partial<ContentTemplateItem>) => api.post<ContentTemplateItem>('/content-templates', payload),
  update: (id: string, payload: Partial<ContentTemplateItem>) => api.put<ContentTemplateItem>(`/content-templates/${id}`, payload),
  remove: (id: string) => api.delete<{ id: string }>(`/content-templates/${id}`),
  /** 套用模板：累加引用次数并返回内容 */
  use: (id: string) => api.post<ContentTemplateItem>(`/content-templates/${id}/use`, {}),
};

export const knowledgeApi = {
  list: (query: { keyword?: string; brand?: string; category?: string; isActive?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<KnowledgeItem>>('/knowledge', { ...query }),
  brands: () => api.get<Array<{ brand: string; count: number }>>('/knowledge/brands'),
  create: (payload: Partial<KnowledgeItem>) => api.post<KnowledgeItem>('/knowledge', payload),
  update: (id: string, payload: Partial<KnowledgeItem>) => api.put<KnowledgeItem>(`/knowledge/${id}`, payload),
  remove: (id: string) => api.delete<{ id: string }>(`/knowledge/${id}`),
  /** 上传文档（PDF/Word/Excel/CSV/txt/md）→ 解析切片 → 生成资料草稿 */
  /** 第一步：只解析文档、不入库，返回可人工校对的分片（OCR 文字单独标注） */
  parseDocument: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiUpload<ParseResult>('/knowledge/parse', form);
  },
  /** 第三步：按人工校对后的分片入库 */
  commitImport: (payload: {
    brand: string;
    category: string;
    priority?: number;
    activate?: boolean;
    sourceFileName?: string;
    tempFile?: string;
    chunks: Array<{ content: string; title?: string; fromOcr?: boolean }>;
  }) => api.post<CommitImportResult>('/knowledge/commit', payload),
  importDocument: (
    file: File,
    payload: { brand: string; category: string; priority?: number; autoActivate?: boolean },
  ) => {
    const form = new FormData();
    form.append('file', file);
    form.append('brand', payload.brand);
    form.append('category', payload.category);
    if (payload.priority !== undefined) form.append('priority', String(payload.priority));
    form.append('autoActivate', payload.autoActivate ? 'true' : 'false');
    return apiUpload<ImportResult>('/knowledge/import', form);
  },
  batchActivate: (ids: string[], isActive: boolean) =>
    api.post<{ updated: number }>('/knowledge/batch-activate', { ids, isActive }),
  batchRemove: (ids: string[]) => api.post<{ removed: number }>('/knowledge/batch-delete', { ids }),
  /** 分类是配置项：下拉、标签、配色都从这里取 */
  categories: () => api.get<{ categories: KnowledgeCategoryView[] }>('/knowledge/categories'),
  saveCategories: (categories: Array<{ code: string; label: string; tone: string; description?: string }>) =>
    api.put<Array<{ code: string; label: string; tone: string }>>('/knowledge/categories', { categories }),
  /** 导出知识库：json（原生，含分类配置）/ csv / markdown */
  exportData: (payload: { format: 'json' | 'csv' | 'markdown'; brand?: string; category?: string; includeInactive?: boolean }) =>
    api.post<KnowledgeExportFile>('/knowledge/export', payload),
  /** 导入第一步：解析文件并自动识别字段映射（不写库） */
  previewImportData: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiUpload<KnowledgeImportPreview>('/knowledge/import-data/preview', form);
  },
  /** 导入第二步：按确认后的映射入库（默认跳过重复） */
  commitImportData: (payload: {
    rows: Array<Record<string, string>>;
    mapping: Record<string, string | undefined>;
    brand: string;
    category: string;
    priority?: number;
    isActive?: boolean;
    skipDuplicates?: boolean;
    sourceFileName?: string;
  }) => api.post<KnowledgeImportResult>('/knowledge/import-data/commit', payload),
  /** 按来源文件分组（导入的资料可按文件整批管理） */
  sources: () => api.get<KnowledgeSourceGroup[]>('/knowledge/sources'),
  /** 知识库体检：重复条目 + 欠打磨条目 */
  audit: () => api.get<KnowledgeAuditReport>('/knowledge/audit'),
  /** 检索测试台：喂一段内容，看会引用哪几条 */
  match: (payload: { title?: string; body?: string; tags?: string[]; platform?: string; limit?: number }) =>
    api.post<{ matches: KnowledgeMatchItem[] }>('/knowledge/match', payload),
  /** AI 起草条目（返回草案，人工确认后再保存） */
  aiDraft: (payload: { brand: string; category: string; points: string; platform?: string; tone?: string }) =>
    api.post<{ draft: KnowledgeDraft; generationId: string; model: string; references: string[] }>('/knowledge/ai-draft', payload),
  /** AI 润色（可作用于未保存的草稿） */
  aiPolish: (payload: { brand?: string; category?: string; content: string; instruction?: string }) =>
    api.post<{ content: string; generationId: string }>('/knowledge/ai-polish', payload),

  /** 预览本次 AI 生成会引用哪些品牌资料 */
  preview: (contentId: string, limit = 5) =>
    api.get<{ matches: KnowledgeMatchItem[] }>('/knowledge/preview', { contentId, limit }),
};
