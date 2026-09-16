import type { AiFlagType, ContentStatus, PlatformCode, PublishTaskStatus } from '@mediaflow/shared';
import { api } from './client';
import type {
  AdaptResult,
  AiTestResult,
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

export const authApi = {
  login: (email: string, password: string) => api.post<LoginResult>('/auth/login', { email, password }),
  me: () => api.get<AuthUser>('/auth/me'),
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
