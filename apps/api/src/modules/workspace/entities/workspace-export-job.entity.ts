import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type WorkspaceExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

/**
 * 工作区数据导出任务（B0.4 第 3 步实现导出功能）。
 *
 * `workspace_id` 刻意不加外键：导出产物要在工作区被永久清除后仍可下载到有效期结束，
 * 若加 CASCADE，删工作区会把导出任务与下载入口一起删掉。
 */
@Entity('workspace_export_jobs')
export class WorkspaceExportJob extends BaseEntity {
  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: WorkspaceExportStatus;

  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  requestedByName!: string | null;

  @Column({ type: 'boolean', default: true })
  includeMedia!: boolean;

  @Column({ type: 'boolean', default: true })
  includeAudit!: boolean;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  filePath!: string | null;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  checksum!: string | null;

  @Column({ type: 'int', default: 0 })
  progress!: number;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;
}
