import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 第 5 步外键补全（13/15，M4–M7）：`platforms.workspace_id` → `workspaces(id)` **ON DELETE CASCADE**。
 *
 * 理由：当前是「每个工作区一份平台字典」（工作区创建时种子），`social_accounts.platform_id` 指向它。若将来改成全局共享字典，需去掉本外键并迁移数据（见第 5 步方案 §5）。
 *
 * 前置守卫：加约束前先断言不存在「孤儿行」（`workspace_id` 指向不存在的工作区），有则抛错中止。
 * 只有先清孤儿再加外键，约束才能建立——本库已在上线前逐表核查并清理（见 `docs/DESIGN-外键补全-第5步.md` §1）。
 *
 * 回滚：仅解除约束，**不删除任何数据**。
 */
export class FkPlatformsWorkspace1789701511000 implements MigrationInterface {
  name = 'FkPlatformsWorkspace1789701511000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans = await queryRunner.query(
      `SELECT count(*)::int AS n FROM "platforms" t
        WHERE t."workspace_id" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w.id = t."workspace_id")`,
    );
    const count = Number(orphans[0]?.n ?? 0);
    if (count > 0) {
      throw new Error(
        `外键补全中止：platforms 有 ${count} 条孤儿行（workspace_id 指向不存在的工作区）。` +
          '请先清理再加外键，见 docs/DESIGN-外键补全-第5步.md §1',
      );
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_platforms_workspace' AND conrelid = '"platforms"'::regclass
        ) THEN
          ALTER TABLE "platforms"
            ADD CONSTRAINT "FK_platforms_workspace"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "platforms" DROP CONSTRAINT IF EXISTS "FK_platforms_workspace"`);
  }
}
