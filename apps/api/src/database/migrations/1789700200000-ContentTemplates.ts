import { MigrationInterface, QueryRunner } from "typeorm";

export class ContentTemplates1789700200000 implements MigrationInterface {
    name = 'ContentTemplates1789700200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "content_templates" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "tenant_id" uuid NOT NULL,
            "workspace_id" uuid NOT NULL,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "name" character varying(120) NOT NULL,
            "description" character varying(300),
            "platform" character varying(40),
            "category" character varying(40),
            "title" character varying(200) NOT NULL,
            "body" text NOT NULL,
            "tags" jsonb NOT NULL DEFAULT '[]',
            "is_active" boolean NOT NULL DEFAULT true,
            "usage_count" integer NOT NULL DEFAULT 0,
            "last_used_at" TIMESTAMP WITH TIME ZONE,
            "created_by" uuid,
            "created_by_name" character varying(80),
            "deleted_at" TIMESTAMP WITH TIME ZONE,
            CONSTRAINT "PK_content_templates" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_content_templates_workspace" ON "content_templates" ("workspace_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_content_templates_active" ON "content_templates" ("is_active")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "content_templates"`);
    }
}
