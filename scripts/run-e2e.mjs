import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 端到端测试入口：从 .env.e2e 读取管理员凭据后运行 api 的 e2e 用例。
 * 凭据不进仓库；没有该文件时给出明确提示而不是静默跳过。
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = join(root, '.env.e2e');
if (!existsSync(envFile)) {
  process.stderr.write('缺少 .env.e2e（需要 E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD）。\n');
  process.exit(1);
}

const env = { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development' };
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !env[match[1]]) env[match[1]] = match[2].trim();
}

const child = spawn('pnpm', ['--filter', '@mediaflow/api', 'run', 'test:e2e'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
