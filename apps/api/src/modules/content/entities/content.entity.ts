import { Column, DeleteDateColumn, Entity, Index, ManyToOne, OneToMany } from 'typeorm';
import { AiFlagType, ContentStatus } from '@mediaflow/shared';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../workspace/entities/user.entity';
import { ContentVariant } from './content-variant.entity';

@Entity('contents')
export class Content extends BaseEntity {
  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  summary!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  coverUrl!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  mediaUrls!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags!: string[];

  @Index()
  @Column({ type: 'varchar', length: 32, default: 'draft' })
  status!: ContentStatus;

  /** Mandatory AI disclosure bookkeeping (AGENTS.md 5). */
  @Column({ type: 'boolean', default: false })
  aiGenerated!: boolean;

  @Column({ type: 'varchar', length: 32, default: 'none' })
  aiFlagType!: AiFlagType;

  @Column({ type: 'boolean', default: false })
  aiFlagChecked!: boolean;

  @Column({ type: 'uuid', nullable: true })
  brandKnowledgeId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  author?: User | null;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;

  @OneToMany(() => ContentVariant, (variant) => variant.content)
  variants?: ContentVariant[];
}
