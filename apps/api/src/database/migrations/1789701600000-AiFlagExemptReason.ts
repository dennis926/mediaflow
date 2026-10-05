import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.6 合规留痕（1/3）：`contents.ai_flag_exempt_reason`。
 *
 * 《人工智能生成合成内容标识办法》要求 AI 生成内容必须显式标识，标识义务在发布者身上。
 * 若某条内容经过 AI 生成（`ai_generations.content_id` 有记录）却把标识填成 `none`，
 * 系统只写一条审计留痕，**不自动改标识、也不拦截发布**（用户明确要求标识默认就是"没有"）。
 * 操作者可以自愿在本列写一句说明（例如"AI 只用来查错别字"），便于事后追溯。
 *
 * 回滚：删除该列（列内数据随之丢失）。
 */
export class AiFlagExemptReason1789701600000 implements MigrationInterface {
  name = 'AiFlagExemptReason1789701600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "contents" ADD COLUMN IF NOT EXISTS "ai_flag_exempt_reason" character varying(200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "contents" DROP COLUMN IF EXISTS "ai_flag_exempt_reason"`);
  }
}
