#!/usr/bin/env node
/**
 * One-off rotation of the settings-encryption master key.
 *
 * Reads the new key from SETTINGS_ENCRYPTION_KEY (>= 32 chars) and the previous key from
 * JWT_SECRET, then re-encrypts every stored ciphertext in system_settings.value.
 * Idempotent: rows already readable with the new key are skipped, so a partially executed
 * run can safely be repeated.
 *
 * Usage: node scripts/rotate-settings-key.cjs --dry-run | --execute
 * Never prints key material or plaintext.
 */
const { createDecipheriv, createCipheriv, randomBytes, scryptSync, createHash } = require('node:crypto');
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const PREFIX = 'enc:v1:';
const SALT = 'mediaflow-settings';
const TABLE = 'system_settings';
const COLUMN = 'value';

const repoRoot = resolve(__dirname, '..', '..', '..');

function loadEnv() {
  const file = join(repoRoot, '.env');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const keyOf = (secret) => scryptSync(secret, SALT, 32);
const fingerprint = (secret) => createHash('sha256').update(secret).digest('hex').slice(0, 12);

function decryptWith(secret, value) {
  if (!value.startsWith(PREFIX)) return { ok: true, plain: value, plaintext: false };
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    return { ok: true, plain, plaintext: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function encryptWith(secret, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

const mask = (plain) => (plain.length <= 8 ? '***' : `${plain.slice(0, 3)}***${plain.slice(-4)}`);

async function main() {
  const mode = process.argv.includes('--execute') ? 'execute' : process.argv.includes('--dry-run') ? 'dry-run' : null;
  if (!mode) {
    console.error('用法：node scripts/rotate-settings-key.cjs --dry-run | --execute');
    process.exit(2);
  }

  const newKey = (env.SETTINGS_ENCRYPTION_KEY ?? '').trim();
  const oldKey = (env.JWT_SECRET ?? '').trim();
  if (newKey.length < 32) {
    console.error(`SETTINGS_ENCRYPTION_KEY 未配置或长度不足（当前 ${newKey.length} 字符，需 ≥ 32），中止。`);
    process.exit(2);
  }

  const { Client } = require('pg');
  const client = new Client({
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 5432),
    database: env.DB_NAME ?? 'mediaflow',
    user: env.DB_USER ?? 'mediaflow',
    password: env.DB_PASSWORD ?? '',
  });
  await client.connect();

  console.log(`模式：${mode}    数据库：${env.DB_NAME ?? 'mediaflow'}`);
  console.log(`新密钥指纹：${fingerprint(newKey)}（${newKey.length} 字符）`);
  console.log(`旧密钥指纹：${oldKey ? fingerprint(oldKey) : '（未配置，无法解旧密文）'}（${oldKey.length} 字符）`);

  // Whole-database safety scan: any ciphertext outside the expected table/column is reported.
  const stray = await client.query(`
    SELECT c.table_name, c.column_name, count(*)::int AS rows
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.data_type IN ('character varying', 'text', 'jsonb')
      AND NOT (c.table_name = $1 AND c.column_name = $2)
    GROUP BY 1, 2`, [TABLE, COLUMN]);
  for (const row of stray.rows) {
    const found = await client.query(
      `SELECT count(*)::int AS n FROM "${row.table_name}" WHERE "${row.column_name}"::text LIKE '${PREFIX}%'`);
    if (found.rows[0].n > 0) {
      console.log(`  ⚠ 额外密文位置：${row.table_name}.${row.column_name}（${found.rows[0].n} 行，脚本不处理，需人工确认）`);
    }
  }

  const { rows } = await client.query(
    `SELECT key, value, length(value) AS len FROM ${TABLE} WHERE ${COLUMN} LIKE $1 ORDER BY key`, [`${PREFIX}%`]);

  console.log(`\n扫描 ${TABLE}.${COLUMN}：密文 ${rows.length} 行`);
  const plan = [];
  for (const row of rows) {
    const withNew = decryptWith(newKey, row.value);
    if (withNew.ok) {
      console.log(`  ${row.key}：已可用新密钥解密 → skip（no-op，明文 ${withNew.plain.length} 字符 / 掩码 ${mask(withNew.plain)}）`);
      continue;
    }
    const withOld = decryptWith(oldKey, row.value);
    if (!withOld.ok) {
      console.error(`  ✗ ${row.key}：新密钥与旧密钥均无法解密（${withOld.error}）→ 中止，不做任何写入`);
      await client.end();
      process.exit(1);
    }
    const projected = encryptWith(newKey, withOld.plain);
    plan.push({ key: row.key, old: row.value, plain: withOld.plain, fresh: projected });
    console.log(`  ${row.key}：需重加密 → 明文 ${withOld.plain.length} 字符（掩码 ${mask(withOld.plain)}），`
      + `旧密文 ${row.len} 字符 → 预计新密文 ${projected.length} 字符`);
  }

  if (mode === 'dry-run') {
    console.log(`\n[dry-run] 将变更：表 ${TABLE}，列 ${COLUMN}，行数 ${plan.length}，数据库 ${env.DB_NAME ?? 'mediaflow'}（未写入任何数据）`);
    await client.end();
    return;
  }

  if (plan.length === 0) {
    console.log('\n[execute] 无需变更（全部行已是新密钥加密），幂等 no-op 结束。');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  const startedAt = Date.now();
  try {
    for (const item of plan) {
      const res = await client.query(
        `UPDATE ${TABLE} SET ${COLUMN} = $1, updated_at = now() WHERE key = $2 AND ${COLUMN} = $3`,
        [item.fresh, item.key, item.old]);
      if (res.rowCount !== 1) throw new Error(`${item.key}：更新行数 ${res.rowCount}（期望 1，密文可能已被并发修改）`);
      const check = await client.query(`SELECT ${COLUMN} AS value FROM ${TABLE} WHERE key = $1`, [item.key]);
      const verify = decryptWith(newKey, check.rows[0].value);
      if (!verify.ok || verify.plain !== item.plain) throw new Error(`${item.key}：写回后校验失败`);
      console.log(`  ✓ ${item.key}：已重加密（明文 ${item.plain.length} 字符 → 新密文 ${check.rows[0].value.length} 字符，回读校验通过）`);
    }
    const scope = await client.query(
      `SELECT tenant_id, workspace_id FROM ${TABLE} WHERE key = $1`, [plan[0].key]);
    const auditPayload = {
      rows: plan.length, table: TABLE, column: COLUMN,
      keys: plan.map((p) => p.key),
      newKeyFingerprint: fingerprint(newKey), oldKeyFingerprint: fingerprint(oldKey),
      executedAt: new Date().toISOString(), mode: 'rotate-settings-key.cjs',
    };
    await client.query(
      `INSERT INTO audit_logs (id, tenant_id, workspace_id, created_at, updated_at, actor_name, action,
        resource_type, resource_id, payload)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), '密钥轮换脚本',
        'settings.encryption_key.rotated', 'system_setting', 'SETTINGS_ENCRYPTION_KEY', $3)`,
      [scope.rows[0].tenant_id, scope.rows[0].workspace_id, JSON.stringify(auditPayload)]);
    await client.query('COMMIT');
    console.log(`\n[execute] 完成：变更 ${plan.length} 行，耗时 ${Date.now() - startedAt} ms，已写入审计日志 settings.encryption_key.rotated`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`\n[execute] 失败并已回滚（数据库未发生变更）：${error.message}`);
    await client.end();
    process.exit(1);
  }
  await client.end();
}

main().catch((error) => {
  console.error(`脚本异常：${error.message}`);
  process.exit(1);
});
