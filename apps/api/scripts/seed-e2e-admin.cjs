#!/usr/bin/env node
/**
 * 为**隔离的 E2E 临时库**准备登录账号（B0.9）。
 *
 * 为什么需要：`pnpm seed` 只建 `admin@mediaflow.local` 且密码是随机生成的，
 * 而端到端测试用的是 `.env.e2e` 里的 E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD。
 * 这个脚本把那个账号按生产库的形态（owner 角色 + 默认工作区成员 + 非超管）补进临时库，
 * 让同一套测试在临时库上原样可跑。
 *
 * 只允许在**非生产库**上执行：库名等于生产库名（默认 mediaflow）时直接退出。
 */
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const DB_NAME = process.env.DB_NAME ?? 'mediaflow';
const PROTECTED = process.env.PRODUCTION_DB_NAME ?? 'mediaflow';
if (DB_NAME === PROTECTED) {
  console.error(`[seed-e2e-admin] 拒绝在疑似生产库上执行（DB_NAME=${DB_NAME}）`);
  process.exit(1);
}

const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;
if (!email || !password) {
  console.error('[seed-e2e-admin] 缺少 E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD');
  process.exit(1);
}

(async () => {
  const client = new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'mediaflow',
    password: process.env.DB_PASSWORD ?? '',
    database: DB_NAME,
  });
  await client.connect();
  try {
    const scope = await client.query("SELECT tenant_id, id FROM workspaces WHERE slug = 'default' LIMIT 1");
    if (scope.rowCount === 0) throw new Error('默认工作区不存在，请先跑 pnpm seed');
    const { tenant_id: tenantId, id: workspaceId } = scope.rows[0];

    const hash = await bcrypt.hash(password, 10);
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    let userId;
    if (existing.rowCount > 0) {
      userId = existing.rows[0].id;
      await client.query('UPDATE users SET password_hash = $2, status = $3, must_change_password = false WHERE id = $1', [userId, hash, 'active']);
    } else {
      const inserted = await client.query(
        `INSERT INTO users (id, tenant_id, workspace_id, created_at, updated_at, email, display_name, password_hash, status, is_super_admin, must_change_password)
         VALUES (gen_random_uuid(), $1, $2, now(), now(), $3, '端到端管理员', $4, 'active', false, false) RETURNING id`,
        [tenantId, workspaceId, email, hash],
      );
      userId = inserted.rows[0].id;
    }

    const role = await client.query("SELECT id FROM roles WHERE code = 'owner' AND tenant_id = $1 LIMIT 1", [tenantId]);
    if (role.rowCount > 0) {
      await client.query('INSERT INTO user_roles (users_id, roles_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, role.rows[0].id]);
    }
    await client.query(
      `INSERT INTO workspace_members (id, tenant_id, workspace_id, created_at, updated_at, user_id, role_codes, invited_by)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), $3, '["owner"]'::jsonb, NULL)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role_codes = '["owner"]'::jsonb`,
      [tenantId, workspaceId, userId],
    );
    console.log(`[seed-e2e-admin] 已准备端到端账号：${email}（workspace=${workspaceId}）`);
  } finally {
    await client.end();
  }
})().catch((error) => {
  console.error(`[seed-e2e-admin] 失败：${error.message}`);
  process.exit(1);
});
