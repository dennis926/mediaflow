#!/usr/bin/env node
/**
 * Fails when a tracked file looks like it contains a real credential.
 * Run before pushing: `pnpm check:secrets`
 */
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  { name: 'AI 密钥', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: '平台 AppSecret', re: /(WECHAT_MP_APP_SECRET|DOUYIN_CLIENT_SECRET|XIAOHONGSHU_APP_SECRET)\s*=\s*[A-Za-z0-9]{12,}/ },
  { name: 'JWT 密钥', re: /JWT_SECRET\s*=\s*[A-Za-z0-9+/=]{20,}/ },
  { name: '访问令牌', re: /(access_token|refresh_token)\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/ },
  { name: '私钥文件', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const allowed = new Set(['.env.example']);
const hits = [];

for (const file of tracked) {
  if (allowed.has(file)) continue;
  let content;
  try {
    content = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(content)) hits.push(`${file} → 命中「${name}」`);
  }
}

if (hits.length > 0) {
  console.error('❌ 检测到疑似真实凭据，请先移除再提交：');
  for (const hit of hits) console.error(`   - ${hit}`);
  process.exit(1);
}

console.log(`✅ 已扫描 ${tracked.length} 个受版本控制的文件，未发现真实凭据（.env 不在其中）`);
