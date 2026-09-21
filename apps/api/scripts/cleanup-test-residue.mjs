#!/usr/bin/env node
/**
 * Remove residue left by an E2E/drill run that crashed or was killed (teardown never ran).
 *
 * Safely scoped: only rows whose original_name/group_name match the suites' own artifact
 * patterns AND whose file is missing on disk are considered; tmp files must be older than 1h.
 * Dry-run by default. Uses psql only (no npm dependency, works under pnpm's strict layout).
 *
 * Usage: node apps/api/scripts/cleanup-test-residue.mjs [--apply]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MEDIA_DIR = join(ROOT, 'uploads/media');
const TMP_DIR = join(ROOT, 'uploads/tmp');
const TMP_AGE_MS = 60 * 60 * 1000;

const env = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD ?? 'mediaflow_dev' };
const psql = (sql) =>
  execFileSync(
    'psql',
    ['-X', '-w', '-q', '-A', '-F', '\t', '-t', '-h', process.env.DB_HOST ?? '127.0.0.1',
     '-U', process.env.DB_USER ?? 'mediaflow', '-d', process.env.DB_NAME ?? 'mediaflow', '-c', sql],
    { env, encoding: 'utf8' },
  );

const raw = psql(
  `SELECT id, stored_name, original_name, coalesce(group_name, '-'), created_at FROM media_assets
    WHERE original_name LIKE 'e2e-%' OR original_name = 'ok.png' OR original_name LIKE 'concurrent-%'
       OR group_name LIKE 'E2E%'`,
);
const rows = raw.split('\n').filter(Boolean).map((line) => {
  const [id, stored, original, group, created] = line.split('\t');
  return { id, stored, original, group, created };
});
const orphans = rows.filter((r) => !existsSync(join(MEDIA_DIR, r.stored)));
const tmpFiles = existsSync(TMP_DIR)
  ? readdirSync(TMP_DIR).filter((f) => Date.now() - statSync(join(TMP_DIR, f)).mtimeMs > TMP_AGE_MS)
  : [];

console.log(`测试特征素材行：${rows.length}，其中孤儿行（文件已不在）：${orphans.length}`);
for (const r of orphans) console.log(`  - ${r.created}  ${r.original}  (${r.group})`);
console.log(`残留临时文件（>1 小时）：${tmpFiles.length}`);
for (const f of tmpFiles) console.log(`  - ${f}`);

if (!APPLY) {
  console.log('\n干跑模式：未做任何改动。加 --apply 执行清理。');
} else {
  if (orphans.length > 0) {
    psql(`DELETE FROM media_assets WHERE id IN (${orphans.map((r) => `'${r.id}'`).join(',')})`);
  }
  for (const f of tmpFiles) unlinkSync(join(TMP_DIR, f));
  console.log(`\n已清理：素材孤儿行 ${orphans.length} 条、临时文件 ${tmpFiles.length} 个`);
}
