import { MigrationInterface, QueryRunner } from "typeorm";

export class UserReviewEnhancements1789648887103 implements MigrationInterface {
    name = 'UserReviewEnhancements1789648887103'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "must_change_password" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "users" ADD "invited_by" uuid`);
        await queryRunner.query(`ALTER TABLE "users" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "content_reviews" ADD "submitted_by" uuid`);
        await queryRunner.query(`ALTER TABLE "content_reviews" ADD "submitted_by_name" character varying(80)`);
        await queryRunner.query(`ALTER TABLE "content_reviews" ADD "reviewer_name" character varying(80)`);
        await queryRunner.query(`ALTER TABLE "content_reviews" ADD "decided_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "content_reviews" DROP COLUMN "decided_at"`);
        await queryRunner.query(`ALTER TABLE "content_reviews" DROP COLUMN "reviewer_name"`);
        await queryRunner.query(`ALTER TABLE "content_reviews" DROP COLUMN "submitted_by_name"`);
        await queryRunner.query(`ALTER TABLE "content_reviews" DROP COLUMN "submitted_by"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "deleted_at"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "invited_by"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "must_change_password"`);
    }

}
