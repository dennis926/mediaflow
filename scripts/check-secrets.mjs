#!/usr/bin/env node
/**
 * Fails when a tracked file looks like it contains a real credential.
 * Run before pushing: `pnpm check:secrets`（CI 也会跑，见 .github/workflows/ci.yml）
 *
 * 覆盖面（2026-09-19 扩充）：
 *  1. 真实密钥：AI Key、平台 AppSecret、JWT 密钥、访问令牌、私钥文件
 *  2. 密文：`enc:v1:` 开头的真实密文（设置里的加密值不该进仓库）
 *  3. 被跟踪的 .env 文件（除 .env.example）
 *  4. 历史泄露的 JWT 密钥：用「指纹比对」识别，不把泄露值本身写进脚本
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const PATTERNS = [
  { name: 'AI 密钥', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: '平台 AppSecret', re: /(WECHAT_MP_APP_SECRET|DOUYIN_CLIENT_SECRET|XIAOHONGSHU_APP_SECRET)\s*=\s*[A-Za-z0-9]{12,}/ },
  { name: 'JWT 密钥', re: /JWT_SECRET\s*=\s*[A-Za-z0-9+/=]{20,}/ },
  { name: '访问令牌', re: /(access_token|refresh_token)\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/ },
  { name: '私钥文件', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // 真实密文（前缀 + 足够长的 base64）；文档里只出现前缀本身不会被误判
  { name: '加密密文（enc:v1:）', re: /enc:v1:[A-Za-z0-9+/=]{40,}/ },
];

/** 2026-09-19 泄露并已轮换的 JWT 密钥指纹（只存指纹，不存值）。 */
const LEAKED_JWT_FINGERPRINT = '9d87f6490bc0';
const ENV_FILE_ALLOWED = new Set(['.env.example']);

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const hits = [];

for (const file of tracked) {
  const base = file.split('/').pop() ?? '';
  // 3. 被跟踪的 .env 文件：真实环境文件绝不能进版本库
  if (/^\.env($|\.)/.test(base) && !ENV_FILE_ALLOWED.has(base)) {
    hits.push(`${file} → 受版本控制的 .env 文件（应加入 .gitignore）`);
  }
  if (ENV_FILE_ALLOWED.has(base)) continue;

  let content;
  try {
    content = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    continue;
  }

  for (const { name, re } of PATTERNS) {
    if (re.test(content)) hits.push(`${file} → 命中「${name}」`);
  }

  // 4. 历史泄露密钥：比对指纹，避免把泄露值写进脚本
  for (const match of content.matchAll(/JWT_SECRET\s*=\s*([A-Za-z0-9+/=]{20,})/g)) {
    if (createHash('sha256').update(match[1]).digest('hex').slice(0, 12) === LEAKED_JWT_FINGERPRINT) {
      hits.push(`${file} → 出现了 2026-09-19 已泄露的 JWT 密钥（指纹 ${LEAKED_JWT_FINGERPRINT}）`);
    }
  }
}

if (hits.length > 0) {
  console.error('❌ 检测到疑似真实凭据，请先移除再提交：');
  for (const hit of hits) console.error(`   - ${hit}`);
  process.exit(1);
}

console.log(`✅ 已扫描 ${tracked.length} 个受版本控制的文件：未发现真实凭据、密文或 .env 文件`);
