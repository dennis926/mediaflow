import { MigrationInterface, QueryRunner } from "typeorm";

export class Notifications1789601907506 implements MigrationInterface {
    name = 'Notifications1789601907506'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "workspace_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "type" character varying(40) NOT NULL, "level" character varying(16) NOT NULL DEFAULT 'info', "title" character varying(200) NOT NULL, "body" text NOT NULL, "channel" character varying(16) NOT NULL DEFAULT 'inbox', "status" character varying(16) NOT NULL DEFAULT 'unread', "resource_type" character varying(60), "resource_id" uuid, "read_at" TIMESTAMP WITH TIME ZONE, "payload" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d93ddd7e1b890535ecafbb334e" ON "notifications" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ff8a9bf1b558104a843964c01e" ON "notifications" ("workspace_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc9f22d0fd3e8c4a1a21ff6a98" ON "notifications" ("workspace_id", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_fc9f22d0fd3e8c4a1a21ff6a98"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ff8a9bf1b558104a843964c01e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d93ddd7e1b890535ecafbb334e"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
    }

}
