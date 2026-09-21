import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';

/** 账单（B 类账本：财务凭据，法律上需长期留存，不随工作区删除而消失）。 */
@Entity('invoices')
export class Invoice extends BaseEntity {
  @Column({ type: 'uuid', nullable: true })
  subscriptionId!: string | null;

  @Column({ type: 'varchar', length: 48, unique: true })
  number!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: InvoiceStatus;

  @Column({ type: 'varchar', length: 8, default: 'CNY' })
  currency!: string;

  @Column({ type: 'bigint', default: 0 })
  amountCents!: string;

  @Column({ type: 'timestamptz', nullable: true })
  periodStart!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  periodEnd!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  issuedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  dueAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  lines!: Array<Record<string, unknown>>;

  @Column({ type: 'varchar', length: 128, nullable: true })
  externalRef!: string | null;
}
