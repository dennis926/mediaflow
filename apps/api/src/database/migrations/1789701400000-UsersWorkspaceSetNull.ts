import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.4 M8（高危修复）：`users.workspace_id` 的 ON DELETE 由 CASCADE 改为 SET NULL，并允许为空。
 *
 * 为什么必须改：这个约束是"用户归属首个工作区"的历史遗留。一旦引入工作区删除/永久清除，
 * CASCADE 会把该工作区下的**用户行一起删掉**——删工作区把人也删了，这是不可接受的。
 * 用户与工作区的真实关系由 `workspace_members` 表达，用户本体必须长期保留
 * （他可能还属于其他工作区，账号也不能凭空消失）。
 *
 * 因此本迁移同时做两件事：
 *   1) DROP NOT NULL（否则 SET NULL 无法落库）
 *   2) 用 SET NULL 外键替换原 CASCADE 外键
 *
 * 回滚（down）：把 NULL 回填为该租户最早的工作区 → 恢复 NOT NULL → 换回原 CASCADE 外键。
 * 注意：回滚会把"已无默认工作区"的用户重新指到某个工作区，属于有损操作，仅在必要时使用。
 */
export class UsersWorkspaceSetNull1789701400000 implements MigrationInterface {
  name = 'UsersWorkspaceSetNull1789701400000';

  /** InitSchema 里历史外键名 */
  private static readonly LEGACY_FK = 'FK_9ef32eab3ccaf4744fd36317c15';
  private static readonly NEW_FK = 'FK_users_workspace_set_null';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "workspace_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "${UsersWorkspaceSetNull1789701400000.LEGACY_FK}"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${UsersWorkspaceSetNull1789701400000.NEW_FK}' AND conrelid = '"users"'::regclass
        ) THEN
          ALTER TABLE "users"
            ADD CONSTRAINT "${UsersWorkspaceSetNull1789701400000.NEW_FK}"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回填：把没有默认工作区的用户指到最早的工作区，才能恢复 NOT NULL
    await queryRunner.query(`
      UPDATE "users" u SET workspace_id = w.id
      FROM (SELECT id FROM "workspaces" ORDER BY created_at ASC LIMIT 1) w
      WHERE u.workspace_id IS NULL
    `);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "${UsersWorkspaceSetNull1789701400000.NEW_FK}"`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "workspace_id" SET NOT NULL`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${UsersWorkspaceSetNull1789701400000.LEGACY_FK}' AND conrelid = '"users"'::regclass
        ) THEN
          ALTER TABLE "users"
            ADD CONSTRAINT "${UsersWorkspaceSetNull1789701400000.LEGACY_FK}"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }
}
