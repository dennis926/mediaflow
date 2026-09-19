import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2-10 外键补齐（1/2）：content_revisions.content_id → contents(id) ON DELETE CASCADE。
 *
 * 版本历史必须依附于内容：内容没了，历史版本没有独立存在的意义（且当前存在孤儿行）。
 * 迁移步骤：先删除孤儿 → 再建外键（否则 FK 创建失败）。
 * 孤儿删除会写审计（data.cleanup.orphan_content_revisions），保证可追溯。
 *
 * 回滚：删除外键（孤儿数据不还原，它们本就不该存在）。
 */
export class ContentRevisionsFk1789700900000 implements MigrationInterface {
  name = 'ContentRevisionsFk1789700900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans: Array<{ id: string }> = await queryRunner.query(`
      SELECT r.id FROM content_revisions r
      WHERE NOT EXISTS (SELECT 1 FROM contents c WHERE c.id = r.content_id)
    `);

    if (orphans.length > 0) {
      await queryRunner.query(`
        DELETE FROM content_revisions r
        WHERE NOT EXISTS (SELECT 1 FROM contents c WHERE c.id = r.content_id)
      `);
      // 平台没有独立的 tenants 表：租户信息挂在 workspaces 上，取最早一个工作区作为审计归属
      await queryRunner.query(
        `INSERT INTO audit_logs (id, tenant_id, workspace_id, created_at, updated_at, actor_name, action,
           resource_type, resource_id, payload)
         SELECT gen_random_uuid(), w.tenant_id, w.id, now(), now(), '数据库迁移',
                'data.cleanup.orphan_content_revisions', 'content_revision', NULL,
                jsonb_build_object('deleted', $1::int, 'migration', 'ContentRevisionsFk1789700900000', 'reason', 'content_id 无对应内容')
         FROM workspaces w ORDER BY w.created_at LIMIT 1`,
        [orphans.length],
      );
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_content_revisions_content' AND conrelid = '"content_revisions"'::regclass
        ) THEN
          ALTER TABLE "content_revisions"
            ADD CONSTRAINT "FK_content_revisions_content"
            FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "content_revisions" DROP CONSTRAINT IF EXISTS "FK_content_revisions_content"`);
  }
}
