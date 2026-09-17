import type { AiFlagType, ContentStatus, PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import { api } from './client';
import type {
  AccountRankingRow,
  KnowledgeItem,
  KnowledgeMatchItem,
  ReviewItem,
  RoleItem,
  UserItem,
  AccountView,
  AdaptResult,
  CalendarDay,
  NotificationItem,
  NotificationPage,
  AiTestResult,
  OverviewData,
  TrendPointData,
  SettingGroupView,
  AdapterDescriptor,
  AiGeneration,
  AuthUser,
  ComplianceReport,
  Content,
  ContentVariant,
  LoginResult,
  Paged,
  PublishTask,
  QueueStats,
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
  variants: (id: string) => api.get<ContentVariant[]>(`/contents/${id}/variants`),
  aiAdapt: (id: string, payload: { platforms: PlatformCode[]; tone?: string; keywords?: string[]; overwrite?: boolean }) =>
    api.post<AdaptResult>(`/contents/${id}/ai-adapt`, payload),
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
  calendar: (weekStart?: string) => api.get<CalendarDay[]>('/publish/calendar', { weekStart }),
  queueStats: () => api.get<QueueStats>('/publish/queue/stats'),
};

export const aiApi = {
  status: () => api.get<{ provider: string; model: string }>('/ai/status'),
  optimizeTitle: (payload: { title: string; platform?: PlatformCode; keywords?: string[] }) =>
    api.post<{ titles: string[]; generationId: string }>('/ai/optimize-title', payload),
  complianceCheck: (payload: { text: string; platform?: PlatformCode; useAiReview?: boolean }) =>
    api.post<ComplianceReport>('/ai/compliance-check', payload),
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

export const knowledgeApi = {
  list: (query: { keyword?: string; brand?: string; category?: string; isActive?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<KnowledgeItem>>('/knowledge', { ...query }),
  brands: () => api.get<Array<{ brand: string; count: number }>>('/knowledge/brands'),
  create: (payload: Partial<KnowledgeItem>) => api.post<KnowledgeItem>('/knowledge', payload),
  update: (id: string, payload: Partial<KnowledgeItem>) => api.put<KnowledgeItem>(`/knowledge/${id}`, payload),
  remove: (id: string) => api.delete<{ id: string }>(`/knowledge/${id}`),
  /** 预览本次 AI 生成会引用哪些品牌资料 */
  preview: (contentId: string, limit = 5) =>
    api.get<{ matches: KnowledgeMatchItem[] }>('/knowledge/preview', { contentId, limit }),
};
