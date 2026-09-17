import { MigrationInterface, QueryRunner } from "typeorm";

export class KnowledgeAiFlag1789656000000 implements MigrationInterface {
    name = 'KnowledgeAiFlag1789656000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "brand_knowledge" ADD "ai_generated" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "brand_knowledge" DROP COLUMN "ai_generated"`);
    }

}
