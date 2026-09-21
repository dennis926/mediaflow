import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type PurgeBatchStatus = 'started' | 'completed' | 'failed';

/**
 * 工作区永久清除账本（B0.4 第 4 步）——**永久保留**（B 类）。
 *
 * 它记录的是"工作区已经不存在"之后仍需保留的证据：谁在何时清了哪个工作区、
 * 逐表删了多少行、文件删了多少、哪些账本被保留、备份放在哪里与校验和。
 * 因此 `workspace_id` **刻意不加外键**（工作区行已不存在）。
 */
@Entity('workspace_purge_batches')
export class WorkspacePurgeBatch extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  workspaceName!: string;

  @Column({ type: 'varchar', length: 50 })
  workspaceSlug!: string;

  @Column({ type: 'varchar', length: 16, default: 'started' })
  status!: PurgeBatchStatus;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  requestedByName!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  deletedRows!: Record<string, number>;

  @Column({ type: 'int', default: 0 })
  deletedFiles!: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  failures!: Array<{ path: string; error: string }>;

  @Column({ type: 'varchar', length: 512, nullable: true })
  backupPath!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  backupSha256!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  backupExpiresAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  ledgerRetained!: string[];

  @Column({ type: 'int', default: 0 })
  socialAccountsDestroyed!: number;

  /** 被保留（未删除）的导出任务数：产物在有效期内仍可下载，见 workspace-export-job.entity.ts 的说明。 */
  @Column({ type: 'int', default: 0 })
  retainedExportJobs!: number;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;
}
