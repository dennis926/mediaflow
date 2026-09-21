import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled';

/** 订阅（B 类账本：工作区被清除后仍保留，用于对账；故不指向 workspaces 建外键）。 */
@Entity('subscriptions')
export class Subscription extends BaseEntity {
  @Column({ type: 'uuid' })
  planId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: SubscriptionStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  trialEndsAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  currentPeriodStart!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  currentPeriodEnd!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  canceledAt!: Date | null;

  /** 外部支付渠道侧的订阅号（B2 接支付后写入） */
  @Column({ type: 'varchar', length: 128, nullable: true })
  externalRef!: string | null;
}
