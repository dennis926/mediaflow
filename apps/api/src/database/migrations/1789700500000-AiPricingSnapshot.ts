import { MigrationInterface, QueryRunner } from "typeorm";

export class AiPricingSnapshot1789700500000 implements MigrationInterface {
    name = 'AiPricingSnapshot1789700500000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_generations" ADD "tokens_cache_write" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "ai_generations" ADD "price_snapshot" jsonb NOT NULL DEFAULT '{}'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_generations" DROP COLUMN "price_snapshot"`);
        await queryRunner.query(`ALTER TABLE "ai_generations" DROP COLUMN "tokens_cache_write"`);
    }
}
