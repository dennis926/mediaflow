import { MigrationInterface, QueryRunner } from "typeorm";

export class ContentRevisions1789700100000 implements MigrationInterface {
    name = 'ContentRevisions1789700100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "content_revisions" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "tenant_id" uuid NOT NULL,
            "workspace_id" uuid NOT NULL,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "content_id" uuid NOT NULL,
            "version" integer NOT NULL,
            "title" character varying(200) NOT NULL,
            "summary" character varying(500),
            "body" text NOT NULL,
            "tags" jsonb NOT NULL DEFAULT '[]',
            "media_urls" jsonb NOT NULL DEFAULT '[]',
            "cover_url" character varying(512),
            "ai_flag_type" character varying(32) NOT NULL,
            "status" character varying(32) NOT NULL,
            "note" character varying(120),
            "created_by" uuid,
            "created_by_name" character varying(80),
            CONSTRAINT "PK_content_revisions" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_content_revisions_content" ON "content_revisions" ("content_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_content_revisions_workspace" ON "content_revisions" ("workspace_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "content_revisions"`);
    }
}
