import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.6 合规留痕（1/3）：`contents.ai_flag_exempt_reason`。
 *
 * 《人工智能生成合成内容标识办法》要求 AI 生成内容必须显式标识。
 * 若某条内容其实经过 AI 生成（`ai_generations.content_id` 有记录），却把标识填成 `none`，
 * 系统必须二选一：**强制回填标识**，或要求填写"为什么不算 AI 生成"的理由并留痕。
 * 这个理由就存在本列里（可空：只有走"豁免"路径的内容才会有值）。
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
