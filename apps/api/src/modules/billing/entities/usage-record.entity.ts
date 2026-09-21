import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { UsageKind } from './plan.entity';

/** 用量流水（B 类账本：配额与计费的事实来源，永久保留）。 */
@Entity('usage_records')
export class UsageRecord extends BaseEntity {
  @Column({ type: 'varchar', length: 32 })
  kind!: UsageKind;

  @Column({ type: 'numeric', precision: 18, scale: 4, default: 0 })
  quantity!: string;

  @Column({ type: 'varchar', length: 16, default: 'count' })
  unit!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  sourceType!: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourceId!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  meta!: Record<string, unknown>;
}
