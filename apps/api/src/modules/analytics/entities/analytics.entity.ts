import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { PlatformCode } from '@mediaflow/shared';
import { BaseEntity } from '../../../database/base.entity';
import { Content } from '../../content/entities/content.entity';

export interface AnalyticsMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
  followers?: number;
}

@Entity('analytics')
@Index(['contentId', 'capturedAt'])
export class Analytics extends BaseEntity {
  @ManyToOne(() => Content, { nullable: true, onDelete: 'CASCADE' })
  content?: Content | null;

  @Column({ type: 'uuid', nullable: true })
  contentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  contentVariantId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  publishTaskId!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 40 })
  platform!: PlatformCode;

  @Column({ type: 'uuid', nullable: true })
  socialAccountId!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  platformPostId!: string | null;

  @Column({ type: 'timestamptz' })
  capturedAt!: Date;

  @Column({ type: 'int', default: 0 })
  views!: number;

  @Column({ type: 'int', default: 0 })
  likes!: number;

  @Column({ type: 'int', default: 0 })
  comments!: number;

  @Column({ type: 'int', default: 0 })
  shares!: number;

  @Column({ type: 'int', default: 0 })
  favorites!: number;

  @Column({ type: 'int', default: 0 })
  followers!: number;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  extra!: Record<string, unknown>;
}
