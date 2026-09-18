import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 删除遗留的 approvals 表。
 *
 * 背景：该表在 InitSchema 里同 contents/publish_tasks 一起创建，但代码中从未有实体/服务/路由引用它，
 * 生产库里长期 0 行（审计判定为"空壳表"）。审批语义由 content_reviews 承担。
 *
 * 回滚：down() 按 InitSchema 的原始定义重建该表（含索引与主键），保证可回退。
 */
export class DropApprovals1789700600000 implements MigrationInterface {
  name = 'DropApprovals1789700600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "approvals"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "approvals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "target_type" character varying(32) NOT NULL,
        "target_id" uuid NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'pending',
        "requested_by" uuid,
        "reviewed_by" uuid,
        "comment" text,
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "payload" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_690417aaefa84d18b1a59e2a499" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_63e5eac9d0712aee7c49014a82" ON "approvals" ("tenant_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_98637628f162aa5d902ab38cca" ON "approvals" ("workspace_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_59c3bb845215eb6ceb5087e23a" ON "approvals" ("target_type", "target_id") `);
  }
}
