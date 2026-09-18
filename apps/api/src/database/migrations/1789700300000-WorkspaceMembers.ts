import { MigrationInterface, QueryRunner } from "typeorm";

export class WorkspaceMembers1789700300000 implements MigrationInterface {
    name = 'WorkspaceMembers1789700300000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "workspace_members" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "tenant_id" uuid NOT NULL,
            "workspace_id" uuid NOT NULL,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "user_id" uuid NOT NULL,
            "role_codes" jsonb NOT NULL DEFAULT '[]',
            "invited_by" uuid,
            CONSTRAINT "PK_workspace_members" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_workspace_members_workspace_user" UNIQUE ("workspace_id", "user_id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_workspace_members_user" ON "workspace_members" ("user_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_workspace_members_workspace" ON "workspace_members" ("workspace_id")`);

        // 存量数据：把每个用户现有的单一工作区补成一条成员记录，角色沿用其全局角色
        await queryRunner.query(`
            INSERT INTO "workspace_members" ("tenant_id", "workspace_id", "user_id", "role_codes")
            SELECT u."tenant_id", u."workspace_id", u."id",
                   COALESCE((
                       SELECT jsonb_agg(r."code")
                       FROM "user_roles" ur JOIN "roles" r ON r."id" = ur."roles_id"
                       WHERE ur."users_id" = u."id"
                   ), '[]'::jsonb)
            FROM "users" u
            ON CONFLICT ("workspace_id", "user_id") DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "workspace_members"`);
    }
}
