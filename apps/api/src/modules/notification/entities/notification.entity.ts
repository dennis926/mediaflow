import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type NotificationLevel = 'info' | 'warning' | 'error';
export type NotificationChannel = 'inbox' | 'email';
export type NotificationStatus = 'unread' | 'read';

/** In-app notification; the same record drives the mock email channel. */
@Entity('notifications')
@Index(['workspaceId', 'status'])
export class Notification extends BaseEntity {
  @Column({ type: 'varchar', length: 40 })
  type!: string;

  @Column({ type: 'varchar', length: 16, default: 'info' })
  level!: NotificationLevel;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', length: 16, default: 'inbox' })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 16, default: 'unread' })
  status!: NotificationStatus;

  @Column({ type: 'varchar', length: 60, nullable: true })
  resourceType!: string | null;

  @Column({ type: 'uuid', nullable: true })
  resourceId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload!: Record<string, unknown>;
}
