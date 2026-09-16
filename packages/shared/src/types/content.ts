import { PlatformCode } from './platform';

export enum ContentStatus {
  Draft = 'draft',
  Reviewing = 'reviewing',
  Approved = 'approved',
  Rejected = 'rejected',
  Archived = 'archived',
}

export enum AiFlagType {
  None = 'none',
  FullyGenerated = 'fully_generated',
  Assisted = 'assisted',
  Translated = 'translated',
}

export enum PublishTaskStatus {
  Pending = 'pending',
  Scheduled = 'scheduled',
  Publishing = 'publishing',
  Published = 'published',
  Failed = 'failed',
  Canceled = 'canceled',
  ManualRequired = 'manual_required',
}

export interface ContentVariantPayload {
  id: string;
  contentId: string;
  platform: PlatformCode;
  title: string;
  body: string;
  tags: string[];
  mediaUrls: string[];
}
