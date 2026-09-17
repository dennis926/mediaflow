import { Column, DeleteDateColumn, Entity, Index } from 'typeorm';
import { PlatformCode } from '@mediaflow/shared';
import { BaseEntity } from '../../../database/base.entity';

/** 分类标识：取值来自可配置的分类表（见 knowledge.categories.ts），因此这里是自由字符串。 */
export type KnowledgeCategory = string;

@Entity('brand_knowledge')
export class BrandKnowledge extends BaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 80 })
  brand!: string;

  @Index()
  @Column({ type: 'varchar', length: 60 })
  category!: KnowledgeCategory;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags!: string[];

  /** 命中检索用的额外关键词（产品名、成分、人群等），与 tags 一起参与匹配。 */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  keywords!: string[];

  /** 数值越大越优先塞进 prompt。 */
  @Column({ type: 'int', default: 0 })
  priority!: number;

  /** 为空表示适用全部平台。 */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  platforms!: PlatformCode[];

  @Column({ type: 'varchar', length: 512, nullable: true })
  sourceUrl!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** 被 AI 引用次数与最近一次引用时间，用于判断资料是否有效。 */
  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  /** 条目由 AI 起草（人工确认后入库）：界面上要标出来，也便于日后追溯。 */
  @Column({ type: 'boolean', default: false })
  aiGenerated!: boolean;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
