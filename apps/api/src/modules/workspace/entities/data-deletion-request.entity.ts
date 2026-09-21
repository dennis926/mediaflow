import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type DataDeletionRequestStatus = 'pending' | 'completed' | 'cancelled';

/**
 * 合规删除请求台账（B0.6）。
 *
 * 只记录"请求"与"结果"，真正的清除仍走 B0.4 的 purge（备份 + 审计 + 账本，不可逆动作只有一条路径）。
 * `due_at` = 请求时刻 + 30 天：收到合规删除请求后必须在此期限前完成清除，
 * 因此创建请求时会把工作区的 `purge_after` **收紧**到不晚于 `due_at`。
 */
@Entity('data_deletion_requests')
export class DataDeletionRequest extends BaseEntity {
  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  requestedByName!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: DataDeletionRequestStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  requestedAt!: Date;

  /** 承诺完成期限：请求时刻 + 30 天 */
  @Column({ type: 'timestamptz' })
  dueAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  /** 完成时关联的 purge 账本行（可据此查"逐表删了多少行、备份在哪"） */
  @Column({ type: 'uuid', nullable: true })
  purgeBatchId!: string | null;
}
