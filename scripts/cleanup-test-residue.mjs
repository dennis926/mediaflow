#!/usr/bin/env node
/**
 * Remove residue left by an E2E/drill run that crashed or was killed (teardown never ran).
 *
 * Safely scoped: only rows whose original_name/group_name match the suites' own artifact
 * patterns AND whose file is missing on disk are considered. Files are never touched unless
 * they are orphan tmp uploads older than --tmp-age-minutes. Dry-run by default.
 *
 * Usage:
 *   node scripts/cleanup-test-residue.mjs            # report only
 *   node scripts/cleanup-test-residue.mjs --apply    # delete
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = join(ROOT, 'uploads/media');
const TMP_DIR = join(ROOT, 'uploads/tmp');
const TMP_AGE_MS = 60 * 60 * 1000;

const client = new pg.Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'mediaflow',
  password: process.env.DB_PASSWORD ?? 'mediaflow_dev',
  database: process.env.DB_NAME ?? 'mediaflow',
});

const rows = (
  await (async () => {
    await client.connect();
    return client.query(
      `SELECT id, stored_name, original_name, group_name, created_at FROM media_assets
        WHERE original_name LIKE 'e2e-%' OR original_name = 'ok.png' OR original_name LIKE 'concurrent-%'
           OR group_name LIKE 'E2E%'`,
    );
  })().then((r) => r.rows),
);

const orphans = rows.filter((row) => !existsSync(join(MEDIA_DIR, row.stored_name)));
const tmpFiles = existsSync(TMP_DIR)
  ? readdirSync(TMP_DIR).filter((f) => Date.now() - statSync(join(TMP_DIR, f)).mtimeMs > TMP_AGE_MS)
  : [];

console.log(`测试特征素材行：${rows.length}，其中孤儿行（文件已不在）：${orphans.length}`);
for (const row of orphans) console.log(`  - ${row.created_at.toISOString?.() ?? row.created_at}  ${row.original_name}  (${row.group_name ?? '-'})`);
console.log(`残留临时文件（>1 小时）：${tmpFiles.length}`);
for (const f of tmpFiles) console.log(`  - ${f}`);

if (!APPLY) {
  console.log('\n干跑模式：未做任何改动。加 --apply 执行清理。');
} else {
  if (orphans.length > 0) {
    await client.query('DELETE FROM media_assets WHERE id = ANY($1)', [orphans.map((r) => r.id)]);
  }
  for (const f of tmpFiles) unlinkSync(join(TMP_DIR, f));
  console.log(`\n已清理：素材孤儿行 ${orphans.length} 条、临时文件 ${tmpFiles.length} 个`);
}
await client.end();
