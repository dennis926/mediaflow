import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

/**
 * 文案模板：把常用写法沉淀下来（科普文、产品答疑、活动通知、朋友圈文案…），
 * 新人不用从空白开始，也能保证口径一致。模板是内容不是配置，可在界面上增删改。
 */
@Entity('content_templates')
export class ContentTemplate extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  description!: string | null;

  /** 适用平台；为空表示通用模板 */
  @Column({ type: 'varchar', length: 40, nullable: true })
  platform!: string | null;

  /** 分类（科普 / 产品 / 活动 / 朋友圈…），自由文本，方便按业务改 */
  @Column({ type: 'varchar', length: 40, nullable: true })
  category!: string | null;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags!: string[];

  @Index()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  createdByName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
