import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type WorkspaceExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

/**
 * 工作区数据导出任务（B0.4 第 3 步实现导出功能）。
 *
 * `workspace_id` 用 **ON DELETE SET NULL**（B0.4 第 5 步定稿，取代第 1 步的"不加外键"）：
 * 导出产物要在工作区被永久清除后仍能下载到有效期结束（SaaS 用户"关停前先导出"是真实场景），
 * 所以删工作区**不能**把任务行一起删掉；但也不能留着悬空引用（那正是本步要消除的孤儿行）。
 * 于是：行保留、`workspace_id` 置空，语义变成"这个产物属于一个已被清除的工作区"。
 * 产物文件不随外键删除，仍由 04:00 的过期清理任务按 7 天有效期处理；行在产物过期后被清理任务删除。
 *
 * 注意类型：`workspace_id` 由 `BaseEntity` 声明为非空（全库统一），但本表在数据库层是可空的。
 * 读取时请用 `jobWorkspaceId(job)` 收窄，不要直接把 `job.workspaceId` 当成一定有值。
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

/**
 * 读取任务的 workspace_id（数据库层可空：工作区被永久清除后会被外键置为 NULL）。
 *
 * 为什么不直接改 BaseEntity：`workspace_id` 在其它几十张表上都是非空，改基类会连累全部实体；
 * 也不在子类里重声明（TS 的 noImplicitOverride + 基类类型不允许）。所以用一个显式收窄函数，
 * 让"这里可能为 null"这件事只在需要的地方出现。
 */
export function jobWorkspaceId(job: { workspaceId: string }): string | null {
  return (job as unknown as { workspaceId: string | null }).workspaceId ?? null;
}
