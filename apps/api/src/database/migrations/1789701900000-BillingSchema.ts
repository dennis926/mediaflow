import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0.7 计费/订阅/配额表结构（5 张表）。
 *
 * 分层与 B0.4 的三分类一致：
 *   - `plans` 是**平台级**字典（不随任何工作区消失）；
 *   - `subscriptions` / `usage_records` / `invoices` 属 **B 类账本**：工作区被永久清除后仍须保留
 *     （计费事实与发票是法律凭据），因此**刻意不加指向 workspaces 的外键**；
 *   - `quotas` 是**周期计数器**（快速路径），随工作区走（有外键 CASCADE）：工作区没了，计数器没有意义。
 *
 * 定价字段一律用默认值占位并标注"待 B2 确认"——本步只做结构与通用配额逻辑，不做定价决策。
 *
 * 回滚：删除这 5 张表（表内数据随之丢失；这正是"回滚 schema 新增"的固有代价）。
 */
export class BillingSchema1789701900000 implements MigrationInterface {
  name = 'BillingSchema1789701900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plans" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "code" varchar(40) NOT NULL UNIQUE,
        "name" varchar(80) NOT NULL,
        "description" text,
        "price_cents" bigint NOT NULL DEFAULT 0,
        "currency" varchar(8) NOT NULL DEFAULT 'CNY',
        "billing_period" varchar(16) NOT NULL DEFAULT 'month',
        "ai_token_quota" bigint NOT NULL DEFAULT 0,
        "publish_quota" integer NOT NULL DEFAULT 0,
        "storage_quota_mb" integer NOT NULL DEFAULT 0,
        "member_quota" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "is_default" boolean NOT NULL DEFAULT false,
        "pricing_note" varchar(200) NOT NULL DEFAULT '待 B2 确认（暂无定价）'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscriptions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "plan_id" uuid NOT NULL REFERENCES "plans"("id") ON DELETE RESTRICT,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "trial_ends_at" timestamptz,
        "current_period_start" timestamptz,
        "current_period_end" timestamptz,
        "canceled_at" timestamptz,
        "external_ref" varchar(128)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_subscriptions_ws_status" ON "subscriptions" ("workspace_id", "status")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "usage_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "kind" varchar(32) NOT NULL,
        "quantity" numeric(18,4) NOT NULL DEFAULT 0,
        "unit" varchar(16) NOT NULL DEFAULT 'count',
        "source_type" varchar(32),
        "source_id" uuid,
        "occurred_at" timestamptz NOT NULL DEFAULT now(),
        "meta" jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_usage_records_ws_kind_time" ON "usage_records" ("workspace_id", "kind", "occurred_at")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invoices" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "subscription_id" uuid,
        "number" varchar(48) NOT NULL UNIQUE,
        "status" varchar(16) NOT NULL DEFAULT 'draft',
        "currency" varchar(8) NOT NULL DEFAULT 'CNY',
        "amount_cents" bigint NOT NULL DEFAULT 0,
        "period_start" timestamptz,
        "period_end" timestamptz,
        "issued_at" timestamptz,
        "due_at" timestamptz,
        "paid_at" timestamptz,
        "lines" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "external_ref" varchar(128)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_invoices_ws_status" ON "invoices" ("workspace_id", "status")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "quotas" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "period" varchar(16) NOT NULL,
        "kind" varchar(32) NOT NULL,
        "limit_value" numeric(18,4) NOT NULL DEFAULT 0,
        "used_value" numeric(18,4) NOT NULL DEFAULT 0,
        "reset_at" timestamptz
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_quotas_ws_period_kind" ON "quotas" ("workspace_id", "period", "kind")`);

    // 参考数据：一个默认计划（配额 0 = 不限制，内部部署用它；定价待 B2）
    await queryRunner.query(`
      INSERT INTO "plans" ("tenant_id", "code", "name", "description", "is_default", "pricing_note")
      VALUES ('11111111-1111-1111-1111-111111111111', 'internal', '内部使用（不限制配额）',
              '内部部署默认计划：AI/发布/存储/成员配额均为 0（不限制）。SaaS 定价与套餐待 B2 确认。', true,
              '待 B2 确认（暂无定价）')
      ON CONFLICT ("code") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "quotas"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_records"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plans"`);
  }
}
