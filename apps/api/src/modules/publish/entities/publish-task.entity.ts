import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { PlatformCode, PublishMode, PublishTaskStatus } from '@mediaflow/shared';
import { BaseEntity } from '../../../database/base.entity';
import { ContentVariant } from '../../content/entities/content-variant.entity';
import { Content } from '../../content/entities/content.entity';
import { SocialAccount } from '../../platform/entities/social-account.entity';

@Entity('publish_tasks')
@Index(['status', 'scheduledAt'])
export class PublishTask extends BaseEntity {
  @ManyToOne(() => Content, { onDelete: 'CASCADE' })
  content?: Content;

  @Index()
  @Column({ type: 'uuid' })
  contentId!: string;

  @ManyToOne(() => ContentVariant, { nullable: true, onDelete: 'SET NULL' })
  contentVariant?: ContentVariant | null;

  @Column({ type: 'uuid', nullable: true })
  contentVariantId!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 40 })
  platform!: PlatformCode;

  @Column({ type: 'varchar', length: 16 })
  publishMode!: PublishMode;

  @ManyToOne(() => SocialAccount, { nullable: true, onDelete: 'SET NULL' })
  socialAccount?: SocialAccount | null;

  @Column({ type: 'uuid', nullable: true })
  socialAccountId!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 32, default: 'pending' })
  status!: PublishTaskStatus;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts!: number;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  platformPostId!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  platformUrl!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;

  /** Set while a queue worker owns the task, which keeps retries idempotent. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  lockedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  extra!: Record<string, unknown>;
}
