import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type UsageKind = 'ai_tokens' | 'publish' | 'upload_mb' | 'member';

/**
 * 套餐（**平台级**字典）。配额取 0 表示"不限制"。
 * 定价字段全是占位：本步不做定价决策，具体价格与套餐划分待 B2 确认。
 *
 * 刻意**不继承 BaseEntity**：套餐不属于任何工作区（与 `roles` 一样是全局字典），
 * 所以表里没有 `workspace_id` 列；若继承基类，TypeORM 会去查一个不存在的列（实测报
 * `column Plan.workspace_id does not exist`）。将来若要做"工作区专属套餐"，再加可空的 workspace_id 列。
 */
@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  tenantId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ type: 'varchar', length: 40, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'bigint', default: 0 })
  priceCents!: string;

  @Column({ type: 'varchar', length: 8, default: 'CNY' })
  currency!: string;

  @Column({ type: 'varchar', length: 16, default: 'month' })
  billingPeriod!: string;

  @Column({ type: 'bigint', default: 0 })
  aiTokenQuota!: string;

  @Column({ type: 'int', default: 0 })
  publishQuota!: number;

  @Column({ type: 'int', default: 0 })
  storageQuotaMb!: number;

  @Column({ type: 'int', default: 0 })
  memberQuota!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ type: 'varchar', length: 200, default: '待 B2 确认（暂无定价）' })
  pricingNote!: string;
}
