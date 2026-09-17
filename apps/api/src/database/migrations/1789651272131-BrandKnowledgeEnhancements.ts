import { MigrationInterface, QueryRunner } from "typeorm";

export class BrandKnowledgeEnhancements1789651272131 implements MigrationInterface {
    name = 'BrandKnowledgeEnhancements1789651272131'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "brand_knowledge" ADD "keywords" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" ADD "priority" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" ADD "platforms" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" ADD "usage_count" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" ADD "last_used_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_f733d0548cf9531004bd4bb2f7" ON "brand_knowledge" ("category") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_f733d0548cf9531004bd4bb2f7"`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" DROP COLUMN "deleted_at"`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" DROP COLUMN "last_used_at"`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" DROP COLUMN "usage_count"`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" DROP COLUMN "platforms"`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" DROP COLUMN "priority"`);
        await queryRunner.query(`ALTER TABLE "brand_knowledge" DROP COLUMN "keywords"`);
    }

}
