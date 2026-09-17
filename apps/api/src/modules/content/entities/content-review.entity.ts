import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Content } from './content.entity';

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

@Entity('content_reviews')
export class ContentReview extends BaseEntity {
  @ManyToOne(() => Content, { onDelete: 'CASCADE' })
  content?: Content;

  @Index()
  @Column({ type: 'uuid' })
  contentId!: string;

  /** Who submitted the content; used to block self-review (职责分离). */
  @Column({ type: 'uuid', nullable: true })
  submittedBy!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  submittedByName!: string | null;

  /** Who made the decision; used to block self-review (职责分离). */
  @Column({ type: 'uuid', nullable: true })
  reviewerId!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  reviewerName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'int', default: 1 })
  round!: number;

  @Index()
  @Column({ type: 'varchar', length: 32, default: 'pending' })
  status!: ReviewStatus;

  @Column({ type: 'text', nullable: true })
  comments!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  checklist!: Record<string, boolean>;
}
