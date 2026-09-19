import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * 类别 7：部署脚本断言（任务 8）
 *
 * 直接跑 `scripts/preflight.sh --config-only`：配置正确必须退出码 0，
 * 任何一条关键配置错了必须退出码 1（部署脚本据此拒绝启动）。
 * 用临时目录里的 .env 副本做输入，不碰真实生产配置。
 */
const ROOT = resolve(process.cwd(), '..', '..');
const tempDirs: string[] = [];

function runPreflight(
  envContent: string,
  mode: '--config-only' = '--config-only',
  script = 'scripts/preflight.sh',
  extraArgs: string[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-preflight-'));
  tempDirs.push(dir);
  const envFile = join(dir, '.env');
  writeFileSync(envFile, envContent, 'utf8');
  chmodSync(envFile, 0o600);

  const result = spawnSync('bash', [script, mode, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, ENV_FILE: envFile },
    encoding: 'utf8',
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const GOOD_ENV = [
  'AUTH_ENFORCED=true',
  'PUBLISH_WORKER_ENABLED=true',
  `SETTINGS_ENCRYPTION_KEY=${'S'.repeat(44)}`,
  `JWT_SECRET=${'J'.repeat(48)}`,
  'MEDIA_MAX_FILE_MB=50',
  '',
].join('\n');

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('部署断言脚本（类别 7）', () => {
  it('配置正确 → 退出码 0', () => {
    const { code, output } = runPreflight(GOOD_ENV);
    expect(output).toContain('关键失败 0 项');
    expect(code).toBe(0);
  });

  it('JWT_SECRET 太短 → 退出码 1，且明确指出原因', () => {
    const { code, output } = runPreflight(GOOD_ENV.replace(`JWT_SECRET=${'J'.repeat(48)}`, 'JWT_SECRET=short'));
    expect(code).toBe(1);
    expect(output).toContain('JWT_SECRET 长度 5');
  });

  it('SETTINGS_ENCRYPTION_KEY 太短 → 退出码 1', () => {
    const { code, output } = runPreflight(GOOD_ENV.replace(`SETTINGS_ENCRYPTION_KEY=${'S'.repeat(44)}`, 'SETTINGS_ENCRYPTION_KEY=tiny'));
    expect(code).toBe(1);
    expect(output).toContain('SETTINGS_ENCRYPTION_KEY 长度 4');
  });

  it('两个密钥相同 → 退出码 1（签名与加密必须分离）', () => {
    const same = 'k'.repeat(48);
    const { code, output } = runPreflight(
      GOOD_ENV.replace(`SETTINGS_ENCRYPTION_KEY=${'S'.repeat(44)}`, `SETTINGS_ENCRYPTION_KEY=${same}`).replace(
        `JWT_SECRET=${'J'.repeat(48)}`,
        `JWT_SECRET=${same}`,
      ),
    );
    expect(code).toBe(1);
    expect(output).toContain('必须分离');
  });

  it('AUTH_ENFORCED 被关掉 → 退出码 1', () => {
    const { code, output } = runPreflight(GOOD_ENV.replace('AUTH_ENFORCED=true', 'AUTH_ENFORCED=false'));
    expect(code).toBe(1);
    expect(output).toContain('AUTH_ENFORCED 必须为 true');
  });

  it('PUBLISH_WORKER_ENABLED 被关掉 → 退出码 1（否则任务永不执行）', () => {
    const { code, output } = runPreflight(GOOD_ENV.replace('PUBLISH_WORKER_ENABLED=true', 'PUBLISH_WORKER_ENABLED=false'));
    expect(code).toBe(1);
    expect(output).toContain('PUBLISH_WORKER_ENABLED 必须为 true');
  });

  it('.env 权限不是 600 → 退出码 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-preflight-'));
    tempDirs.push(dir);
    const envFile = join(dir, '.env');
    writeFileSync(envFile, GOOD_ENV, 'utf8');
    chmodSync(envFile, 0o644);

    const result = spawnSync('bash', ['scripts/preflight.sh', '--config-only'], {
      cwd: ROOT,
      env: { ...process.env, ENV_FILE: envFile },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('.env 权限为 644');
  });

  it('部署脚本 --check-only --config-only：配置正确 → 0，配置错误 → 1（失败即拒绝启动）', () => {
    const good = runPreflight(GOOD_ENV, '--config-only', 'scripts/deploy.sh', ['--check-only']);
    // deploy.sh 需要同时带 --check-only 才只跑断言
    expect(good.output).toContain('关键失败 0 项');

    const bad = runPreflight(
      GOOD_ENV.replace('AUTH_ENFORCED=true', 'AUTH_ENFORCED=false'),
      '--config-only',
      'scripts/deploy.sh',
      ['--check-only'],
    );
    expect(bad.code).toBe(1);
    expect(bad.output).toContain('已中止部署');
  });
});
