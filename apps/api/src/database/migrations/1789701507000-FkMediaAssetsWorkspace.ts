import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 第 5 步外键补全（13/15，M4–M7）：`media_assets.workspace_id` → `workspaces(id)` **ON DELETE CASCADE**。
 *
 * 理由：素材行属于工作区。注意：**磁盘文件不由外键删除**——purge 会在删行前逐文件清理；因此禁止绕过 purge 直接删工作区行（见 RUNBOOK）。
 *
 * 前置守卫：加约束前先断言不存在「孤儿行」（`workspace_id` 指向不存在的工作区），有则抛错中止。
 * 只有先清孤儿再加外键，约束才能建立——本库已在上线前逐表核查并清理（见 `docs/DESIGN-外键补全-第5步.md` §1）。
 *
 * 回滚：仅解除约束，**不删除任何数据**。
 */
export class FkMediaAssetsWorkspace1789701507000 implements MigrationInterface {
  name = 'FkMediaAssetsWorkspace1789701507000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans = await queryRunner.query(
      `SELECT count(*)::int AS n FROM "media_assets" t
        WHERE t."workspace_id" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w.id = t."workspace_id")`,
    );
    const count = Number(orphans[0]?.n ?? 0);
    if (count > 0) {
      throw new Error(
        `外键补全中止：media_assets 有 ${count} 条孤儿行（workspace_id 指向不存在的工作区）。` +
          '请先清理再加外键，见 docs/DESIGN-外键补全-第5步.md §1',
      );
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_media_assets_workspace' AND conrelid = '"media_assets"'::regclass
        ) THEN
          ALTER TABLE "media_assets"
            ADD CONSTRAINT "FK_media_assets_workspace"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media_assets" DROP CONSTRAINT IF EXISTS "FK_media_assets_workspace"`);
  }
}
