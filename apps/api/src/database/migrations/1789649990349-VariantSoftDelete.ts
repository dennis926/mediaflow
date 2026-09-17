import { MigrationInterface, QueryRunner } from "typeorm";

export class VariantSoftDelete1789649990349 implements MigrationInterface {
    name = 'VariantSoftDelete1789649990349'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "content_variants" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "content_variants" DROP COLUMN "deleted_at"`);
    }

}
