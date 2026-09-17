import { AiGeneration } from '../modules/ai/entities/ai-generation.entity';
import { Analytics } from '../modules/analytics/entities/analytics.entity';
import { TrackEvent } from '../modules/analytics/entities/track-event.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';
import { BrandKnowledge } from '../modules/content/entities/brand-knowledge.entity';
import { ContentReview } from '../modules/content/entities/content-review.entity';
import { ContentVariant } from '../modules/content/entities/content-variant.entity';
import { Content } from '../modules/content/entities/content.entity';
import { Notification } from '../modules/notification/entities/notification.entity';
import { Platform } from '../modules/platform/entities/platform.entity';
import { SocialAccount } from '../modules/platform/entities/social-account.entity';
import { Approval } from '../modules/publish/entities/approval.entity';
import { PublishTask } from '../modules/publish/entities/publish-task.entity';
import { SystemSetting } from '../modules/settings/entities/system-setting.entity';
import { Role } from '../modules/workspace/entities/role.entity';
import { User } from '../modules/workspace/entities/user.entity';
import { Workspace } from '../modules/workspace/entities/workspace.entity';

export * from '../modules/ai/entities/ai-generation.entity';
export * from '../modules/analytics/entities/analytics.entity';
export * from '../modules/analytics/entities/track-event.entity';
export * from '../modules/audit/entities/audit-log.entity';
export * from '../modules/content/entities/brand-knowledge.entity';
export * from '../modules/content/entities/content-review.entity';
export * from '../modules/content/entities/content-variant.entity';
export * from '../modules/content/entities/content.entity';
export * from '../modules/notification/entities/notification.entity';
export * from '../modules/platform/entities/platform.entity';
export * from '../modules/platform/entities/social-account.entity';
export * from '../modules/publish/entities/approval.entity';
export * from '../modules/publish/entities/publish-task.entity';
export * from '../modules/settings/entities/system-setting.entity';
export * from '../modules/workspace/entities/role.entity';
export * from '../modules/workspace/entities/user.entity';
export * from '../modules/workspace/entities/workspace.entity';

/** Every entity, so TypeOrmModule can load them by class (stable identity in tests too). */
export const ALL_ENTITIES = [
  AiGeneration,
  Analytics,
  TrackEvent,
  AuditLog,
  BrandKnowledge,
  ContentReview,
  ContentVariant,
  Content,
  Notification,
  Platform,
  SocialAccount,
  Approval,
  PublishTask,
  SystemSetting,
  Role,
  User,
  Workspace,
];
