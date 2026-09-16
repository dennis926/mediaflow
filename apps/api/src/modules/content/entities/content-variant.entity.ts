import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { AiFlagType, ContentStatus, PlatformCode } from '@mediaflow/shared';
import { BaseEntity } from '../../../database/base.entity';
import { Content } from './content.entity';

@Entity('content_variants')
@Index(['contentId', 'platform'], { unique: true })
export class ContentVariant extends BaseEntity {
  @ManyToOne(() => Content, (content) => content.variants, { onDelete: 'CASCADE' })
  content?: Content;

  @Column({ type: 'uuid' })
  contentId!: string;

  @Index()
  @Column({ type: 'varchar', length: 40 })
  platform!: PlatformCode;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  mediaUrls!: string[];

  @Column({ type: 'varchar', length: 32, default: 'draft' })
  status!: ContentStatus;

  @Column({ type: 'boolean', default: false })
  aiGenerated!: boolean;

  @Column({ type: 'varchar', length: 32, default: 'none' })
  aiFlagType!: AiFlagType;

  @Column({ type: 'uuid', nullable: true })
  generationId!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  extra!: Record<string, unknown>;
}
