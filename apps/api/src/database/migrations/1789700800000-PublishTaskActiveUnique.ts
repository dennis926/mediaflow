import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2-2 重复排期：同一内容在同一平台不允许存在多条「未完成任务」。
 *
 * 服务端已在 createTasks 里做了友好校验（409），这里再加数据库级兜底：
 * 并发提交时两个请求可能都通过了校验，唯一索引保证只有一条能落库（另一个命中 23505 → 服务端转 409）。
 *
 * 迁移前先处理历史重复：同一 (content_id, platform) 的多条活跃任务只保留最早的一条，
 * 其余置为 canceled（不硬删，保留追溯）。
 *
 * 回滚：删除索引（已置为 canceled 的历史任务不还原——它们本就不该同时活跃）。
 */
export class PublishTaskActiveUnique1789700800000 implements MigrationInterface {
  name = 'PublishTaskActiveUnique1789700800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates: Array<{ content_id: string; platform: string }> = await queryRunner.query(`
      SELECT content_id, platform
      FROM publish_tasks
      WHERE status IN ('pending', 'scheduled', 'publishing')
      GROUP BY content_id, platform
      HAVING COUNT(*) > 1
    `);

    for (const duplicate of duplicates) {
      await queryRunner.query(
        `UPDATE publish_tasks SET status = 'canceled',
           error_message = COALESCE(error_message, '') || ' [迁移 1789700800000：同内容同平台重复排期，保留最早一条]',
           finished_at = now(), updated_at = now()
         WHERE id IN (
           SELECT id FROM publish_tasks
           WHERE content_id = $1 AND platform = $2 AND status IN ('pending', 'scheduled', 'publishing')
           ORDER BY created_at ASC
           OFFSET 1
         )`,
        [duplicate.content_id, duplicate.platform],
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_publish_tasks_active_content_platform"
      ON "publish_tasks" ("content_id", "platform")
      WHERE "status" IN ('pending', 'scheduled', 'publishing')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_publish_tasks_active_content_platform"`);
  }
}
