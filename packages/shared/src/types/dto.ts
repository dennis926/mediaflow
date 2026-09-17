import { AiFlagType, ContentStatus, PublishTaskStatus } from './content';
import { PlatformCode, PublishMode } from './platform';

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  items: T[];
  meta: PaginationMeta;
}

export interface ContentVariantDto {
  id: string;
  contentId: string;
  platform: PlatformCode;
  title: string;
  body: string;
  tags: string[];
  status: ContentStatus;
  aiGenerated: boolean;
  aiFlagType: AiFlagType;
  generationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentDto {
  id: string;
  title: string;
  summary: string | null;
  body: string;
  coverUrl: string | null;
  mediaUrls: string[];
  tags: string[];
  status: ContentStatus;
  aiGenerated: boolean;
  aiFlagType: AiFlagType;
  aiFlagChecked: boolean;
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  variants?: ContentVariantDto[];
}

export interface PublishTaskDto {
  id: string;
  contentId: string;
  platform: PlatformCode;
  publishMode: PublishMode;
  status: PublishTaskStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  platformUrl: string | null;
  extra: Record<string, unknown>;
  createdAt: string;
  content?: { id: string; title: string };
  contentVariant?: ContentVariantDto | null;
}

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  workspaceId: string;
  roles: string[];
  isSuperAdmin: boolean;
  /** 管理员重置/邀请生成的临时密码需要首次登录后修改。 */
  mustChangePassword?: boolean;
}

export interface LoginResultDto {
  accessToken: string;
  expiresIn: string;
  user: AuthUserDto;
}

export interface AdapterDescriptorDto {
  platform: PlatformCode;
  label: string;
  mode: PublishMode;
  capabilities: {
    mode: PublishMode;
    canPublish: boolean;
    canFetchAnalytics: boolean;
    canInteract: boolean;
    supportsSchedule: boolean;
    maxBodyLength: number;
    supportedMedia: string[];
  };
}

export interface QueueStatsDto {
  length: number;
  pending: number;
  consumers: number;
}
