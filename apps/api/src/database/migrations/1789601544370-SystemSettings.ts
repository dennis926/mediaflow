import { MigrationInterface, QueryRunner } from "typeorm";

export class SystemSettings1789601544370 implements MigrationInterface {
    name = 'SystemSettings1789601544370'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "system_settings" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "workspace_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "key" character varying(80) NOT NULL, "value" text, "is_secret" boolean NOT NULL DEFAULT false, "updated_by" uuid, CONSTRAINT "PK_82521f08790d248b2a80cc85d40" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2c211a073170ae051bb52e6685" ON "system_settings" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_1054e9c5ed820501a064f1b3f7" ON "system_settings" ("workspace_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5f65e27568da019d71396f6e10" ON "system_settings" ("workspace_id", "key") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5f65e27568da019d71396f6e10"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1054e9c5ed820501a064f1b3f7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2c211a073170ae051bb52e6685"`);
        await queryRunner.query(`DROP TABLE "system_settings"`);
    }

}
