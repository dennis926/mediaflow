import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 M3：工作区硬删（purge）账本表 —— 归入"永久保留"的 B 类账本。
 *
 * 它记录的是"工作区已经不存在"之后仍需保留的证据：谁在什么时候删了哪个工作区、
 * 逐表删了多少行、文件删了多少、哪些账本数据被保留、备份放在哪里。
 * 因此 workspace_id 同样**不加外键**。
 *
 * 回滚：删表。
 */
export class WorkspacePurgeBatches1789701300000 implements MigrationInterface {
  name = 'WorkspacePurgeBatches1789701300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workspace_purge_batches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "workspace_name" character varying(100) NOT NULL,
        "workspace_slug" character varying(50) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "status" character varying(16) NOT NULL DEFAULT 'started',
        "reason" text,
        "requested_by" uuid,
        "requested_by_name" character varying(80),
        "deleted_rows" jsonb NOT NULL DEFAULT '{}',
        "deleted_files" integer NOT NULL DEFAULT 0,
        "failures" jsonb NOT NULL DEFAULT '[]',
        "backup_path" character varying(512),
        "backup_sha256" character varying(128),
        "backup_expires_at" TIMESTAMP WITH TIME ZONE,
        "ledger_retained" jsonb NOT NULL DEFAULT '[]',
        "social_accounts_destroyed" integer NOT NULL DEFAULT 0,
        "error_message" text,
        CONSTRAINT "PK_workspace_purge_batches" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_workspace_purge_batches_ws" ON "workspace_purge_batches" ("workspace_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_workspace_purge_batches_backup_expires" ON "workspace_purge_batches" ("backup_expires_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "workspace_purge_batches"`);
  }
}
