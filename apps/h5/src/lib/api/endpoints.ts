import type { Paged, PlatformCode, PublishTaskDto, PublishTaskStatus } from '@mediaflow/shared';
import { api } from './client';

export interface MobileAuthUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  tenantId?: string;
  workspaceId?: string;
  isSuperAdmin?: boolean;
  /** True while an admin-issued temporary password is still in use. */
  mustChangePassword?: boolean;
}

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ accessToken: string; expiresIn: string; user: MobileAuthUser }>('/auth/login', { email, password }),
  me: () => api.get<MobileAuthUser>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ success: true }>('/auth/change-password', { currentPassword, newPassword }),
};

export interface TaskQuery {
  page?: number;
  pageSize?: number;
  status?: PublishTaskStatus;
  platform?: PlatformCode;
}

export const publishApi = {
  tasks: (query: TaskQuery) => api.get<Paged<PublishTaskDto>>('/publish/tasks', { ...query }),
  task: (id: string) => api.get<PublishTaskDto>(`/publish/tasks/${id}`),
  retry: (id: string) => api.post<PublishTaskDto>(`/publish/tasks/${id}/retry`),
  queueStats: () => api.get<{ length: number; pending: number; consumers: number }>('/publish/queue/stats'),
};

export const contentApi = {
  count: (query: { status?: string; pageSize?: number }) => api.get<Paged<{ id: string }>>('/contents', query),
};

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';
export type ReviewDecision = 'approved' | 'rejected' | 'changes_requested';

/**
 * Review row as returned by GET /api/reviews.
 * The API exposes both the joined `content` relation and the flattened `contentTitle`,
 * so optional fields are used and normalized in the UI layer.
 */
export interface MobileReviewItem {
  id: string;
  contentId: string;
  status: ReviewStatus;
  contentTitle?: string;
  content?: { id?: string; title?: string; summary?: string };
  round?: number;
  comments?: string | null;
  /** Alias some API revisions use for `comments`. */
  note?: string | null;
  checklist?: Record<string, boolean>;
  submittedBy?: string | null;
  submittedByName?: string | null;
  reviewerName?: string | null;
  /** ISO timestamp of submission; falls back to `createdAt`. */
  submittedAt?: string | null;
  createdAt?: string | null;
  decidedAt?: string | null;
}

export interface MobileReviewPage {
  items: MobileReviewItem[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  pendingCount: number;
}

export const reviewsApi = {
  list: (query: { status?: ReviewStatus; page?: number; pageSize?: number }) =>
    api.get<MobileReviewPage>('/reviews', { ...query }),
  decide: (id: string, payload: { decision: ReviewDecision; comments?: string }) =>
    api.put<MobileReviewItem>(`/reviews/${id}`, payload),
  checklist: () => api.get<{ labels: Record<string, string> }>('/reviews/checklist'),
};
