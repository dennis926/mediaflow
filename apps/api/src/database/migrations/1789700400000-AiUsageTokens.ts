import { MigrationInterface, QueryRunner } from "typeorm";

export class AiUsageTokens1789700400000 implements MigrationInterface {
    name = 'AiUsageTokens1789700400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_generations" ADD "tokens_cached" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "ai_generations" ADD "tokens_reasoning" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_generations" DROP COLUMN "tokens_reasoning"`);
        await queryRunner.query(`ALTER TABLE "ai_generations" DROP COLUMN "tokens_cached"`);
    }
}
