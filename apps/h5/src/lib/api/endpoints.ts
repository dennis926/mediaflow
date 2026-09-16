import type { Paged, PlatformCode, PublishTaskDto, PublishTaskStatus } from '@mediaflow/shared';
import { api } from './client';

export interface MobileAuthUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
}

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ accessToken: string; expiresIn: string; user: MobileAuthUser }>('/auth/login', { email, password }),
  me: () => api.get<MobileAuthUser>('/auth/me'),
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
