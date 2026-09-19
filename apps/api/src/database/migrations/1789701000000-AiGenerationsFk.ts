import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2-10 外键补齐（2/2）：ai_generations.content_id → contents(id) ON DELETE SET NULL。
 *
 * AI 调用流水属于成本/审计资料，内容被删除后仍要保留（用于成本核算与用量追溯），
 * 因此用 SET NULL 而不是 CASCADE——这一点与 content_revisions 的取舍刻意不同。
 *
 * 回滚：删除外键。
 */
export class AiGenerationsFk1789701000000 implements MigrationInterface {
  name = 'AiGenerationsFk1789701000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 先断开指向不存在内容的引用（不删流水本体）
    await queryRunner.query(`
      UPDATE ai_generations g SET content_id = NULL
      WHERE content_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM contents c WHERE c.id = g.content_id)
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_ai_generations_content' AND conrelid = '"ai_generations"'::regclass
        ) THEN
          ALTER TABLE "ai_generations"
            ADD CONSTRAINT "FK_ai_generations_content"
            FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_generations" DROP CONSTRAINT IF EXISTS "FK_ai_generations_content"`);
  }
}
