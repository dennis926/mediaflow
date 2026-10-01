#!/usr/bin/env node
/**
 * Tenant scope guard.
 *
 * Why this exists: workspace isolation here is enforced per query
 * (`where: { workspaceId: scope.workspaceId }`), which is easy to forget - and it was
 * forgotten once: publish task get/retry/cancel/requeue looked rows up by `{ id }` alone,
 * so any workspace admin could read, retry and CANCEL another workspace's publish task.
 * Tests missed it because every suite ran with a single workspace.
 *
 * This is the structural backstop. It flags **reads addressed by a bare id** - the shape
 * that actually leaks: fetch a row by id, then return it, retry it, cancel it - and fails
 * the build unless that exact line carries a `tenant-scope-ok:` marker with a reason.
 *
 * Exemptions are per line, not per file: a file-level allowlist would hide the next P0-1
 * dropped into publish.service.ts (which is exactly where the original one lived).
 *
 * What it deliberately does NOT flag:
 * - writes (`update`/`delete`/`softDelete`) by id: safe when the row was read through a
 *   scoped query first, which is the normal pattern here - flagging them is pure noise.
 * - reads filtered by other columns (`contentId`, `userId`, ...): child rows reached
 *   through an already-scoped parent.
 * - `select: { id: true }` projections.
 * Flagging those produced 89 hits of which ~0 were real, and a check nobody reads is worse
 * than no check at all.
 *
 * Usage: node scripts/check-tenant-scope.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SCAN_ROOT = join(ROOT, 'apps/api/src');
const MARKER = 'tenant-scope-ok:';

/** Reads only - the leak shape is "fetch by id, then act on it". */
const METHODS = ['findOne', 'findOneBy', 'findOneOrFail', 'findBy', 'find', 'findAndCount', 'count', 'countBy', 'exists', 'exist'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Returns the text inside the balanced (...) starting at the index of '('. */
function readArgs(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return '';
}

/** `{ id }` / `{ id: x }` addressed by a bare id - not `contentId`, not a `select` projection. */
function addressesByBareId(text) {
  const withoutProjections = text.replace(/id\s*:\s*(true|false)/g, '');
  return /\{\s*id\s*[,:}]/.test(withoutProjections);
}

const SCOPED = /workspaceId|workspace_id|tenantId|tenant_id/;

const findings = [];
const markers = [];
for (const file of walk(SCAN_ROOT)) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    if (line.includes(MARKER)) {
      markers.push({ file: rel, line: index + 1, reason: line.slice(line.indexOf(MARKER) + MARKER.length).trim() });
    }
  });

  for (const method of METHODS) {
    const needle = `.${method}(`;
    let from = 0;
    for (;;) {
      const at = source.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;
      const args = readArgs(source, at + needle.length - 1);
      if (!args || SCOPED.test(args) || !addressesByBareId(args)) continue;
      const line = source.slice(0, at).split('\n').length;
      findings.push({
        file: rel,
        line,
        method,
        snippet: args.replace(/\s+/g, ' ').trim().slice(0, 110),
        // a marker on the call line itself, or on the line just above it, counts
        marked: (lines[line - 1] ?? '').includes(MARKER) || (lines[line - 2] ?? '').includes(MARKER),
      });
    }
  }
}

const violations = findings.filter((finding) => !finding.marked);
const exempted = findings.filter((finding) => finding.marked);
const unusedMarkers = markers.filter(
  (marker) =>
    !marker.reason ||
    !findings.some((finding) => finding.file === marker.file && (finding.line === marker.line || finding.line === marker.line + 1)),
);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ findings, violations, unusedMarkers }, null, 2));
  process.exit(0);
}

const problems = [];
if (violations.length > 0) {
  problems.push(
    `✗ 发现 ${violations.length} 处按 id 读取但缺少工作区过滤：\n` +
      violations.map((v) => `  ${v.file}:${v.line}  .${v.method}( ${v.snippet} )`).join('\n') +
      '\n\n处理方式：补上 workspaceId: scope.workspaceId；确实安全的，在该行加注释 // tenant-scope-ok: <原因>',
  );
}
if (unusedMarkers.length > 0) {
  problems.push(
    `✗ 有 ${unusedMarkers.length} 个 tenant-scope-ok 标记失效（无对应调用或未写原因），请删除或补原因：\n` +
      unusedMarkers.map((m) => `  ${m.file}:${m.line}`).join('\n'),
  );
}

if (problems.length > 0) {
  console.error(problems.join('\n\n'));
  process.exit(1);
}

console.log(`✓ 租户作用域巡检通过：按 id 读取 ${findings.length} 处，其中 ${exempted.length} 处带原因豁免，其余均带工作区过滤`);
