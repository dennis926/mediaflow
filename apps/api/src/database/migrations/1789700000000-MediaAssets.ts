import { MigrationInterface, QueryRunner } from "typeorm";

export class MediaAssets1789700000000 implements MigrationInterface {
    name = 'MediaAssets1789700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "media_assets" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "tenant_id" uuid NOT NULL,
            "workspace_id" uuid NOT NULL,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "stored_name" character varying(200) NOT NULL,
            "original_name" character varying(255) NOT NULL,
            "mime_type" character varying(120) NOT NULL,
            "kind" character varying(20) NOT NULL,
            "size" bigint NOT NULL,
            "url" character varying(512) NOT NULL,
            "uploaded_by" uuid,
            "uploaded_by_name" character varying(80),
            "group_name" character varying(80),
            "deleted_at" TIMESTAMP WITH TIME ZONE,
            CONSTRAINT "PK_media_assets" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_media_assets_tenant" ON "media_assets" ("tenant_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_media_assets_workspace" ON "media_assets" ("workspace_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_media_assets_kind" ON "media_assets" ("kind")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "media_assets"`);
    }
}
