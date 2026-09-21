import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 第 5 步外键补全（13/15，M4–M7）：`content_revisions.workspace_id` → `workspaces(id)` **ON DELETE CASCADE**。
 *
 * 理由：修订历史属于内容（B0.2 已加 `content_id → contents CASCADE`），不该跨工作区存活。
 *
 * 前置守卫：加约束前先断言不存在「孤儿行」（`workspace_id` 指向不存在的工作区），有则抛错中止。
 * 只有先清孤儿再加外键，约束才能建立——本库已在上线前逐表核查并清理（见 `docs/DESIGN-外键补全-第5步.md` §1）。
 *
 * 回滚：仅解除约束，**不删除任何数据**。
 */
export class FkContentRevisionsWorkspace1789701502000 implements MigrationInterface {
  name = 'FkContentRevisionsWorkspace1789701502000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans = await queryRunner.query(
      `SELECT count(*)::int AS n FROM "content_revisions" t
        WHERE t."workspace_id" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w.id = t."workspace_id")`,
    );
    const count = Number(orphans[0]?.n ?? 0);
    if (count > 0) {
      throw new Error(
        `外键补全中止：content_revisions 有 ${count} 条孤儿行（workspace_id 指向不存在的工作区）。` +
          '请先清理再加外键，见 docs/DESIGN-外键补全-第5步.md §1',
      );
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_content_revisions_workspace' AND conrelid = '"content_revisions"'::regclass
        ) THEN
          ALTER TABLE "content_revisions"
            ADD CONSTRAINT "FK_content_revisions_workspace"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "content_revisions" DROP CONSTRAINT IF EXISTS "FK_content_revisions_workspace"`);
  }
}
