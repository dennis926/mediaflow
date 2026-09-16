import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type ApprovalTargetType = 'content' | 'publish_task' | 'content_variant';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'canceled';

@Entity('approvals')
@Index(['targetType', 'targetId'])
export class Approval extends BaseEntity {
  @Column({ type: 'varchar', length: 32 })
  targetType!: ApprovalTargetType;

  @Column({ type: 'uuid' })
  targetId!: string;

  @Column({ type: 'varchar', length: 32, default: 'pending' })
  status!: ApprovalStatus;

  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload!: Record<string, unknown>;
}
