#!/usr/bin/env node
/**
 * 版本迭代脚本。
 *
 * 一次调用完成：改版本号 → 改 CHANGELOG → 打标签 → 提交。
 * 目的是让"界面显示的版本"和"git 提交/标签"永远对得上，排查线上问题时能一句话定位到代码。
 *
 * 用法：
 *   node scripts/release.mjs patch "修复发布队列重试次数统计"     # 0.2.0 → 0.2.1
 *   node scripts/release.mjs minor "新增 AI 官方价格自动抓取"     # 0.2.0 → 0.3.0
 *   node scripts/release.mjs major "首个对外 SaaS 版本"           # 0.2.0 → 1.0.0
 *   node scripts/release.mjs patch "只改版本号，不提交" --no-commit
 *
 * 只做本地操作，不会推送远端（推送由部署流程单独负责）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = join(ROOT, 'packages/shared/src/constants/version.ts');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

/** 所有需要同步版本号的 package.json。 */
const PACKAGE_FILES = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/h5/package.json',
  'apps/plugin/package.json',
  'packages/shared/package.json',
  'packages/design-tokens/package.json',
  'packages/channel-adapters/package.json',
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options }).trim();
}

function readVersion() {
  const source = readFileSync(VERSION_FILE, 'utf8');
  const match = /APP_VERSION = '([^']+)'/.exec(source);
  if (!match) fail(`无法从 ${VERSION_FILE} 读取 APP_VERSION`);
  return match[1];
}

function bump(version, kind) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    fail(`当前版本号不是 x.y.z 形式：${version}`);
  }
  const [major, minor, patch] = parts;
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  fail(`未知的版本类型：${kind}（可用：patch / minor / major）`);
}

function writeVersions(next) {
  const source = readFileSync(VERSION_FILE, 'utf8');
  writeFileSync(VERSION_FILE, source.replace(/APP_VERSION = '[^']+'/, `APP_VERSION = '${next}'`));
  for (const relative of PACKAGE_FILES) {
    const path = join(ROOT, relative);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version === next) continue;
    parsed.version = next;
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

function prependChangelog(version, note) {
  const today = new Date().toISOString().slice(0, 10);
  const header = '# 更新日志\n\n> 每次交付迭代都追加一条，并打上 `v<版本号>` 标签。\n\n';
  const entry = `## v${version} — ${today}\n\n- ${note}\n\n`;
  const current = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : header;
  if (current.startsWith('# 更新日志')) {
    const body = current.slice(current.indexOf('\n\n', header.length - 4) + 2);
    writeFileSync(CHANGELOG, `${header}${entry}${body}`);
  } else {
    writeFileSync(CHANGELOG, `${header}${entry}${current}`);
  }
}

const [kind, note, ...flags] = process.argv.slice(2);
if (!kind || !note) {
  fail('用法：node scripts/release.mjs <patch|minor|major> "本次改动说明" [--no-commit]');
}
if (kind === '--help' || kind === '-h') {
  console.log('用法：node scripts/release.mjs <patch|minor|major> "本次改动说明" [--no-commit]');
  process.exit(0);
}

const current = readVersion();
const next = bump(current, kind);
writeVersions(next);
prependChangelog(next, note);
console.log(`✓ 版本号：${current} → ${next}`);

if (!flags.includes('--no-commit')) {
  const dirty = git(['status', '--porcelain']);
  if (!dirty) fail('没有任何改动可提交（先用 --no-commit 只改版本号）');
  git(['add', '-A']);
  git(['commit', '-m', `chore(release): v${next} — ${note}`]);
  git(['tag', '-a', `v${next}`, '-m', `v${next} — ${note}`]);
  console.log(`✓ 已提交并打标签 v${next}`);
} else {
  console.log('（--no-commit：只改了文件，未提交）');
}
