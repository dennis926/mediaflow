import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.6 合规留痕（2/3）：`content_reviews.operator_ip` / `operator_ua`。
 *
 * 审核是"谁在什么时候、用什么身份放行了什么内容"的关键动作，合规审计需要能回答
 * "这条内容是谁审的、从哪个地址、用什么客户端"。此前只记了 reviewer id/name。
 *
 * 回滚：删除两列（列内数据随之丢失）。
 */
export class ReviewOperatorTrail1789701700000 implements MigrationInterface {
  name = 'ReviewOperatorTrail1789701700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "content_reviews" ADD COLUMN IF NOT EXISTS "operator_ip" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "content_reviews" ADD COLUMN IF NOT EXISTS "operator_ua" character varying(256)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "content_reviews" DROP COLUMN IF EXISTS "operator_ua"`);
    await queryRunner.query(`ALTER TABLE "content_reviews" DROP COLUMN IF EXISTS "operator_ip"`);
  }
}
