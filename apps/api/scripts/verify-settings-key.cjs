#!/usr/bin/env node
/**
 * Read-only probe: verifies that every ciphertext in system_settings.value decrypts with the
 * key currently configured in .env (SETTINGS_ENCRYPTION_KEY). Used after key rotation and
 * during the post-rotation observation window.
 *
 * Usage: node scripts/verify-settings-key.cjs
 * Never prints key material; prints only plaintext length and a masked prefix.
 */
const { createDecipheriv, scryptSync, createHash } = require('node:crypto');
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '..', '..', '..');
const env = {};
const file = join(repoRoot, '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].trim();
  }
}

const master = (env.SETTINGS_ENCRYPTION_KEY ?? '').trim();
if (master.length < 32) {
  console.error(`SETTINGS_ENCRYPTION_KEY 未配置或过短（${master.length} 字符），无法校验。`);
  process.exit(2);
}
console.log(`主密钥指纹：${createHash('sha256').update(master).digest('hex').slice(0, 12)}（${master.length} 字符）`);

const key = scryptSync(master, 'mediaflow-settings', 32);
const decrypt = (value) => {
  const raw = Buffer.from(value.slice('enc:v1:'.length), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
};

(async () => {
  const { Client } = require('pg');
  const client = new Client({
    host: env.DB_HOST ?? '127.0.0.1', port: Number(env.DB_PORT ?? 5432),
    database: env.DB_NAME ?? 'mediaflow', user: env.DB_USER ?? 'mediaflow', password: env.DB_PASSWORD ?? '',
  });
  await client.connect();
  const { rows } = await client.query(
    "SELECT key, value, length(value) AS len FROM system_settings WHERE value LIKE 'enc:v1:%' ORDER BY key");
  let ok = 0;
  for (const row of rows) {
    try {
      const plain = decrypt(row.value);
      ok += 1;
      console.log(`  ✓ ${row.key}：解密成功 | 明文 ${plain.length} 字符 | 掩码 ${plain.slice(0, 3)}***${plain.slice(-4)} | 密文 ${row.len} 字符`);
    } catch (error) {
      console.log(`  ✗ ${row.key}：解密失败 | ${error.message}`);
    }
  }
  console.log(`\n结果：${ok}/${rows.length} 行可用当前主密钥解密`);
  await client.end();
  process.exit(ok === rows.length ? 0 : 1);
})();
