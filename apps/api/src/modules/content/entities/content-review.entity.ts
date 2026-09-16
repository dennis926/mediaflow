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

  @Column({ type: 'uuid', nullable: true })
  reviewerId!: string | null;

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
