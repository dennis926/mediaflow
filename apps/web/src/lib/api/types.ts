import type { AiFlagType, ContentStatus, PlatformCode, PublishMode, PublishTaskStatus } from '@mediaflow/shared';

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

export interface ContentVariant {
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

export interface Content {
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
  variants?: ContentVariant[];
}

export interface PublishTask {
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
}

export interface AdapterDescriptor {
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

export interface QueueStats {
  length: number;
  pending: number;
  consumers: number;
}

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

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  workspaceId: string;
  roles: string[];
  isSuperAdmin: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: string;
  user: AuthUser;
}

export interface AdaptResult {
  contentId: string;
  generationId: string;
  model: string;
  variants: ContentVariant[];
  skipped: PlatformCode[];
}
