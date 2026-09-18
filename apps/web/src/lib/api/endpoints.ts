import type { AiFlagType, ContentStatus, PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import { api, apiUpload } from './client';
import type {
  AccountRankingRow,
  AccountView,
  AdaptResult,
  AdapterDescriptor,
  AiGeneration,
  AiTestResult,
  AuthUser,
  CalendarDay,
  CommitImportResult,
  ComplianceReport,
  Content,
  ContentRevisionItem,
  ContentVariant,
  ImportResult,
  KnowledgeAuditReport,
  KnowledgeCategoryView,
  KnowledgeExportFile,
  KnowledgeImportPreview,
  KnowledgeImportResult,
  KnowledgeDraft,
  KnowledgeItem,
  AiUsageSummary,
  AuditLogItem,
  MediaAssetItem,
  SiteConfigView,
  KnowledgeMatchItem,
  KnowledgeSourceGroup,
  LoginResult,
  NotificationItem,
  NotificationPage,
  OverviewData,
  Paged,
  ParseResult,
  PublishTask,
  QueueStats,
  ReviewItem,
  RoleItem,
  SettingGroupView,
  TrendPointData,
  UserItem,
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
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ success: true }>('/auth/change-password', { currentPassword, newPassword }),
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
};

export const aiApi = {
  status: () => api.get<{ provider: string; model: string }>('/ai/status'),
  optimizeTitle: (payload: { title: string; platform?: PlatformCode; keywords?: string[] }) =>
    api.post<{ titles: string[]; generationId: string }>('/ai/optimize-title', payload),
  complianceCheck: (payload: { text: string; platform?: PlatformCode; useAiReview?: boolean }) =>
    api.post<ComplianceReport>('/ai/compliance-check', payload),
  usage: (days = 14) => api.get<AiUsageSummary>('/ai/usage', { days }),
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
