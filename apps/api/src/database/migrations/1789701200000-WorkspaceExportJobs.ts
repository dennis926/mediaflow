import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 M2：租户数据导出任务表。
 *
 * workspace_id **刻意不加外键**：导出产物要在工作区硬删后仍可下载到有效期结束，
 * 若加了 CASCADE，删工作区会把导出任务与下载入口一起删掉。
 *
 * 回滚：删表。
 */
export class WorkspaceExportJobs1789701200000 implements MigrationInterface {
  name = 'WorkspaceExportJobs1789701200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workspace_export_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "status" character varying(16) NOT NULL DEFAULT 'queued',
        "requested_by" uuid,
        "requested_by_name" character varying(80),
        "include_media" boolean NOT NULL DEFAULT true,
        "include_audit" boolean NOT NULL DEFAULT true,
        "note" text,
        "file_path" character varying(512),
        "size_bytes" bigint,
        "checksum" character varying(128),
        "progress" integer NOT NULL DEFAULT 0,
        "error_message" text,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_workspace_export_jobs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_workspace_export_jobs_ws_status" ON "workspace_export_jobs" ("workspace_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_workspace_export_jobs_expires" ON "workspace_export_jobs" ("expires_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "workspace_export_jobs"`);
  }
}
