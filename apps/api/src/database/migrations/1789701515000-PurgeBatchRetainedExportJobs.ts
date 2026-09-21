import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 账本补列（不属于 15 条外键，独立迁移以保持"一表一迁移"的可回滚性）：
 * `workspace_purge_batches.retained_export_jobs` —— purge 时**被保留**（未删除）的导出任务数。
 *
 * 为什么需要：第 5 步把导出任务的处置从"删除"改成"保留 + 置空"（见 FkWorkspaceExportJobsWorkspace），
 * 清除账本必须能如实说明"这次清除留了多少导出任务、产物在有效期内仍可下载"，否则账本与事实不符。
 *
 * 回滚：删除该列（列内数据随之丢失，属于纯新增列回滚的固有代价）。
 */
export class PurgeBatchRetainedExportJobs1789701515000 implements MigrationInterface {
  name = 'PurgeBatchRetainedExportJobs1789701515000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspace_purge_batches" ADD COLUMN IF NOT EXISTS "retained_export_jobs" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workspace_purge_batches" DROP COLUMN IF EXISTS "retained_export_jobs"`);
  }
}
