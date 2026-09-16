import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('brand_knowledge')
export class BrandKnowledge extends BaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 80 })
  brand!: string;

  @Column({ type: 'varchar', length: 60 })
  category!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags!: string[];

  @Column({ type: 'varchar', length: 512, nullable: true })
  sourceUrl!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
