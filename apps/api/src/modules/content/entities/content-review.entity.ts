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

  /**
   * 审批时内容的 updatedAt 快照。
   * 用来判断"审批之后内容是否又被改过" —— 不能用 decidedAt 比较：
   * 审批本身会更新内容状态，从而刷新 updatedAt，会让比较永远为真（实测踩过）。
   */
  @Column({ type: 'timestamptz', nullable: true })
  contentUpdatedAt!: Date | null;

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
