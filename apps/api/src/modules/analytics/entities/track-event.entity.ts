import { Column, Entity, Index } from 'typeorm';
import { PlatformCode } from '@mediaflow/shared';
import { BaseEntity } from '../../../database/base.entity';

@Entity('track_events')
@Index(['eventName', 'occurredAt'])
export class TrackEvent extends BaseEntity {
  @Column({ type: 'varchar', length: 80 })
  eventName!: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  platform!: PlatformCode | null;

  @Column({ type: 'uuid', nullable: true })
  contentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  contentVariantId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  socialAccountId!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  sessionId!: string | null;

  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  properties!: Record<string, unknown>;
}
