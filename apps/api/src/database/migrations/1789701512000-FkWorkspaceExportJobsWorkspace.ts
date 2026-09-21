import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 第 5 步外键补全（14/15，M4–M7）：`workspace_export_jobs.workspace_id` → `workspaces(id)` **ON DELETE SET NULL**。
 *
 * 为什么本表不用 CASCADE（澄清第 1 步设计与第 5 步规则表的矛盾后定稿）：
 * 第 1 步设计要求"导出产物要在工作区硬删后仍可下载到有效期结束"（SaaS 用户关停前先导出是真实场景），
 * 因此删工作区**不能**把任务行一起删掉；但第 1 步的"不加外键"会留下悬空引用（正是本步要消除的孤儿行）。
 * 定稿：行保留 + `workspace_id` 置空 —— 既满足下载需求，又保持引用完整性。
 *
 * 配套改动（同一交付，缺一不可）：
 *   1. 本迁移：列改为可空 + 加 SET NULL 外键；
 *   2. `WorkspaceExportService.resolveDownload()` 按 jobId 查（令牌已用 HMAC 绑定 workspace+job），工作区置空后已发出的链接仍可用；
 *   3. `createDownloadLink()` 允许**原申请人本人**在产物有效期内取回已被清除工作区的产物，并写审计 `workspace.export.link_issued_after_purge`；
 *   4. purge 不再删除导出任务行，改为在账本记 `retainedExportJobs`（`workspace_purge_batches.retained_export_jobs`）；
 *   5. 04:00 过期清理任务：产物删除后，已被清除工作区的任务行一并删除（否则这些行永远没有归属，只会堆积）。
 *
 * 前置守卫：断言没有孤儿行。
 * 回滚：解除约束；若届时确实没有 NULL 行，则恢复 NOT NULL（存在 NULL 行时保持可空，避免回滚失败）。
 */
export class FkWorkspaceExportJobsWorkspace1789701512000 implements MigrationInterface {
  name = 'FkWorkspaceExportJobsWorkspace1789701512000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans = await queryRunner.query(
      `SELECT count(*)::int AS n FROM "workspace_export_jobs" t
        WHERE t."workspace_id" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w.id = t."workspace_id")`,
    );
    const count = Number(orphans[0]?.n ?? 0);
    if (count > 0) {
      throw new Error(
        `外键补全中止：workspace_export_jobs 有 ${count} 条孤儿行。请先清理再加外键，见 docs/DESIGN-外键补全-第5步.md §1`,
      );
    }

    await queryRunner.query(`ALTER TABLE "workspace_export_jobs" ALTER COLUMN "workspace_id" DROP NOT NULL`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_workspace_export_jobs_workspace'
            AND conrelid = '"workspace_export_jobs"'::regclass
        ) THEN
          ALTER TABLE "workspace_export_jobs"
            ADD CONSTRAINT "FK_workspace_export_jobs_workspace"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workspace_export_jobs" DROP CONSTRAINT IF EXISTS "FK_workspace_export_jobs_workspace"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM "workspace_export_jobs" WHERE "workspace_id" IS NULL) THEN
          ALTER TABLE "workspace_export_jobs" ALTER COLUMN "workspace_id" SET NOT NULL;
        END IF;
      END $$;
    `);
  }
}
