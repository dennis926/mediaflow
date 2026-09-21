import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.6 合规留痕（3/3）：`data_deletion_requests` —— 合规删除请求台账。
 *
 * 法规/合规场景要求"收到删除请求后 **30 天内**完成清除"，所以必须有一张表记录：
 * 谁在什么时候提出、针对哪个工作区、约定什么时候前完成、最终是否真的清除了（关联 purge 账本）。
 * 清除路径完全复用 B0.4 的软删 → 保留期 → 永久清除（有备份、有审计、有账本），
 * 本表只是"请求侧"的凭据，不新增不可逆动作。
 *
 * 回滚：删除该表。
 */
export class DataDeletionRequests1789701800000 implements MigrationInterface {
  name = 'DataDeletionRequests1789701800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "data_deletion_requests" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "requested_by" uuid,
        "requested_by_name" varchar(80),
        "reason" text,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "requested_at" timestamptz NOT NULL DEFAULT now(),
        "due_at" timestamptz NOT NULL,
        "completed_at" timestamptz,
        "purge_batch_id" uuid
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_data_deletion_requests_ws" ON "data_deletion_requests" ("workspace_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_data_deletion_requests_due" ON "data_deletion_requests" ("status", "due_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "data_deletion_requests"`);
  }
}
