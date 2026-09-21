import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { UsageKind } from './plan.entity';

/**
 * 周期配额计数器（快路径）。
 * 与 B 类账本不同，这张表**随工作区走**（迁移里带 CASCADE 外键）：工作区没了，计数器没有意义。
 */
@Entity('quotas')
export class Quota extends BaseEntity {
  /** 周期标识：按月的用 `YYYY-MM`；瞬时类（如成员数）用 `instant` */
  @Column({ type: 'varchar', length: 16 })
  period!: string;

  @Column({ type: 'varchar', length: 32 })
  kind!: UsageKind;

  /** 0 = 不限制 */
  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  limitValue!: string;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  usedValue!: string;

  @Column({ type: 'timestamptz', nullable: true })
  resetAt!: Date | null;
}
