import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 M1：工作区生命周期字段。
 *
 * 新增 archived_at / deleted_at / purge_after 三列，并为「到期清理扫描」加复合索引；
 * 同时把历史上可能存在的 status='suspended' 统一改写为 'archived'（该状态从未投入使用，
 * 语义与归档重叠），避免出现第四种状态。
 *
 * 回滚：删列与索引（status 的改写不还原——'suspended' 已废弃）。
 */
export class WorkspaceArchiveFields1789701100000 implements MigrationInterface {
  name = 'WorkspaceArchiveFields1789701100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "purge_after" TIMESTAMP WITH TIME ZONE`);

    const legacy: Array<{ id: string }> = await queryRunner.query(`SELECT id FROM workspaces WHERE status = 'suspended'`);
    if (legacy.length > 0) {
      await queryRunner.query(`UPDATE workspaces SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE status = 'suspended'`);
      await queryRunner.query(
        `INSERT INTO audit_logs (id, tenant_id, workspace_id, created_at, updated_at, actor_name, action, resource_type, resource_id, payload)
         SELECT gen_random_uuid(), w.tenant_id, w.id, now(), now(), '数据库迁移', 'workspace.status_migrated', 'workspace', w.id,
                jsonb_build_object('from', 'suspended', 'to', 'archived', 'migration', 'WorkspaceArchiveFields1789701100000')
         FROM workspaces w WHERE w.status = 'archived' AND w.archived_at IS NOT NULL`,
      );
    }

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_workspaces_status_purge_after" ON "workspaces" ("status", "purge_after")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_workspaces_status_purge_after"`);
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "purge_after"`);
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "deleted_at"`);
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "archived_at"`);
  }
}
