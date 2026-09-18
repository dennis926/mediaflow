import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * content_reviews 增加 content_updated_at：审批时的内容版本快照。
 * 回滚：删除该列（历史数据不需要恢复，因为它只用于"审批后是否被改动"的判断）。
 */
export class ReviewContentVersion1789700700000 implements MigrationInterface {
  name = 'ReviewContentVersion1789700700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "content_reviews" ADD COLUMN IF NOT EXISTS "content_updated_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "content_reviews" DROP COLUMN IF EXISTS "content_updated_at"`);
  }
}
