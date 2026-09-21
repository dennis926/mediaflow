import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 第 5 步外键补全（15/15，M4–M7）：`workspace_members.workspace_id` → `workspaces(id)` **ON DELETE CASCADE**。
 *
 * 理由：成员关系是「用户 ↔ 工作区」的连接，工作区消失后连接必须消失；**用户本身不删**（M8 已把 `users.workspace_id` 改为 SET NULL，归属由本表表达）。
 *
 * 前置守卫：加约束前先断言不存在「孤儿行」（`workspace_id` 指向不存在的工作区），有则抛错中止。
 * 只有先清孤儿再加外键，约束才能建立——本库已在上线前逐表核查并清理（见 `docs/DESIGN-外键补全-第5步.md` §1）。
 *
 * 回滚：仅解除约束，**不删除任何数据**。
 */
export class FkWorkspaceMembersWorkspace1789701513000 implements MigrationInterface {
  name = 'FkWorkspaceMembersWorkspace1789701513000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans = await queryRunner.query(
      `SELECT count(*)::int AS n FROM "workspace_members" t
        WHERE t."workspace_id" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "workspaces" w WHERE w.id = t."workspace_id")`,
    );
    const count = Number(orphans[0]?.n ?? 0);
    if (count > 0) {
      throw new Error(
        `外键补全中止：workspace_members 有 ${count} 条孤儿行（workspace_id 指向不存在的工作区）。` +
          '请先清理再加外键，见 docs/DESIGN-外键补全-第5步.md §1',
      );
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_workspace_members_workspace' AND conrelid = '"workspace_members"'::regclass
        ) THEN
          ALTER TABLE "workspace_members"
            ADD CONSTRAINT "FK_workspace_members_workspace"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workspace_members" DROP CONSTRAINT IF EXISTS "FK_workspace_members_workspace"`);
  }
}
