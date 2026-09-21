#!/usr/bin/env node
/**
 * 端到端测试运行器（B0.9：**隔离版**）。
 *
 * 设计目标（对应 TECHDEBT-E2E隔离.md 的根因）：E2E 不能再读写生产数据库与 Redis。
 *
 * 流程：
 *   0. 前置断言：解析出的目标库名/端口绝不能等于生产库（否则立刻退出，不跑任何测试）
 *   1. 起临时 Postgres + Redis（docker-compose.e2e.yml，无持久卷，删容器即销毁）
 *   2. 等健康 → 在临时库里跑迁移 + 种子（生产库一行都不碰）
 *   3. 跑 vitest 之前启动"生产库哨兵"：每 3 秒查一次生产库里有没有 E2E 特征数据
 *   4. 跑测试（环境变量全部指向临时依赖）
 *   5. 无论成功失败：停哨兵 → 核对哨兵结果（生产库必须 0 命中）→ 销毁容器（down -v）
 *
 * 退出码：测试失败、哨兵命中、或清理失败都会是非 0。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = 'docker-compose.e2e.yml';
const E2E_DB = 'mediaflow_e2e';
const E2E_DB_PORT = '55432';
const E2E_REDIS_PORT = '56379';
const E2E_USER = 'mediaflow_e2e';
const E2E_PASSWORD = 'mediaflow_e2e';

const step = (message) => console.log(`\n== ${message} ==`);
const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const production = readEnvFile(join(ROOT, '.env'));
const productionDbName = production.DB_NAME ?? 'mediaflow';
const productionDbPort = production.DB_PORT ?? '5432';

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    cwd: ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    timeout: options.timeout ?? 600_000,
  });
}

function psql(database, sql, credentials) {
  return execFileSync(
    'psql',
    ['-X', '-w', '-q', '-A', '-t', '-h', '127.0.0.1', '-p', credentials.port, '-U', credentials.user, '-d', database, '-c', sql],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PGPASSWORD: credentials.password }, timeout: 120_000 },
  ).trim();
}

/** 生产库哨兵：测试期间不断检查生产库里有没有 E2E 特征数据（有就说明测试写到了生产库）。 */
function startSentinel() {
  const hits = [];
  let samples = 0;
  const credentials = { port: productionDbPort, user: production.DB_USER ?? 'mediaflow', password: production.DB_PASSWORD ?? '' };
  // 两类证据：① 生产库里出现 E2E 特征数据；② 生产库上出现"E2E 专用账号"的连接
  // （E2E 用 mediaflow_e2e 这个角色连库；它一旦出现在生产库的 pg_stat_activity 里就说明连错了库）
  const sql = `SELECT (SELECT count(*) FROM contents WHERE title LIKE 'E2E%')
                    + (SELECT count(*) FROM users WHERE email LIKE 'e2e-%@example.com')
                    + (SELECT count(*) FROM workspaces WHERE name LIKE 'E2E%')
                    + (SELECT count(*) FROM pg_stat_activity WHERE usename = '${E2E_USER}' AND datname = current_database())`;
  const timer = setInterval(() => {
    try {
      const value = Number(psql(productionDbName, sql, credentials));
      samples += 1;
      if (value > 0) hits.push({ at: new Date().toISOString(), value });
    } catch {
      // 生产库查询失败不影响测试；但会计入 samples=0，从而让"哨兵有效性"断言失败
    }
  }, 3000);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      return { samples, hits };
    },
  };
}

async function main() {
  step('第 0 步：前置断言（绝不连生产库）');
  if (E2E_DB === productionDbName) fail(`E2E 目标库名与生产库相同（${productionDbName}）——拒绝运行`);
  if (E2E_DB_PORT === String(productionDbPort)) fail(`E2E 端口与生产库端口相同（${E2E_DB_PORT}）——拒绝运行`);
  console.log(`  生产库：${productionDbName}@${productionDbPort}（只读哨兵）`);
  console.log(`  E2E 库：${E2E_DB}@${E2E_DB_PORT}（临时容器，跑完销毁）`);

  let started = false;
  let sentinel = null;
  let exitCode = 0;
  try {
    step('第 1 步：起临时 Postgres + Redis');
    compose(['up', '-d', '--wait'], { timeout: 300_000 });
    started = true;
    console.log('  容器已就绪（healthcheck 通过）');

    step('第 2 步：临时库迁移 + 种子（不碰生产库）');
    const e2eEnv = {
      NODE_ENV: 'development',
      DB_HOST: '127.0.0.1',
      DB_PORT: E2E_DB_PORT,
      DB_NAME: E2E_DB,
      DB_USER: E2E_USER,
      DB_PASSWORD: E2E_PASSWORD,
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: E2E_REDIS_PORT,
    };
    execFileSync('pnpm', ['migrate'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...e2eEnv } });
    execFileSync('pnpm', ['seed'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...e2eEnv } });
    // 把 .env.e2e 里的账号按生产形态补进临时库（pnpm seed 只建 admin@mediaflow.local）
    execFileSync('node', ['scripts/seed-e2e-admin.cjs'], {
      cwd: join(ROOT, 'apps', 'api'),
      stdio: 'inherit',
      env: { ...process.env, ...e2eEnv, ...readEnvFile(join(ROOT, '.env.e2e')), PRODUCTION_DB_NAME: productionDbName },
    });

    step('第 2c 步：Redis 隔离断言（run_id 必须不同）');
    const redisRunId = (port) => {
      const out = execFileSync('redis-cli', ['-p', String(port), 'info', 'server'], { encoding: 'utf8', timeout: 15_000 });
      return /run_id:([0-9a-f]+)/.exec(out)?.[1] ?? '';
    };
    const productionRunId = redisRunId(production.REDIS_PORT ?? '6379');
    const e2eRunId = redisRunId(E2E_REDIS_PORT);
    console.log(`  生产 Redis run_id=${productionRunId.slice(0, 12)}…；E2E Redis run_id=${e2eRunId.slice(0, 12)}…`);
    if (!productionRunId || !e2eRunId) fail('无法读取 Redis run_id（隔离无法证明）');
    if (productionRunId === e2eRunId) fail('E2E 与生产用了同一个 Redis 实例（run_id 相同）');
    console.log('  ✓ 两个 Redis 实例不同（队列/缓存完全隔离）');

    step('第 3 步：启动生产库哨兵（每 3 秒采样一次）');
    sentinel = startSentinel();
    console.log('  哨兵已启动：若测试期间生产库出现 E2E 特征数据，将在结束时判定失败');

    step('第 4 步：跑测试（全部指向临时依赖）');
    const apiDir = join(ROOT, 'apps', 'api');
    const e2eFileEnv = readEnvFile(join(ROOT, '.env.e2e'));
    exitCode = await new Promise((resolve) => {
      const child = spawn('npx', ['vitest', 'run', 'test/'], {
        cwd: apiDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          ...e2eEnv,
          ...e2eFileEnv,
          E2E_ADMIN_EMAIL: e2eFileEnv.E2E_ADMIN_EMAIL ?? 'admin@liangyijianye.com',
          E2E_ADMIN_PASSWORD: e2eFileEnv.E2E_ADMIN_PASSWORD ?? '',
        },
      });
      child.on('exit', (code) => resolve(code ?? 1));
    });
    console.log(`  测试退出码：${exitCode}`);

    step('第 5 步：核对哨兵结果');
    const report = sentinel.stop();
    sentinel = null;
    console.log(`  采样次数：${report.samples}；生产库命中次数：${report.hits.length}`);
    if (report.samples === 0) {
      console.error('  ✗ 哨兵一次都没采到样（生产库不可达？）→ 无法证明隔离，判为失败');
      exitCode = exitCode || 2;
    }
    if (report.hits.length > 0) {
      console.error(`  ✗ E2E 期间生产库出现了测试数据：${JSON.stringify(report.hits.slice(0, 3))}`);
      exitCode = exitCode || 3;
    } else if (report.samples > 0) {
      console.log('  ✓ 生产库零命中：测试确实没有读写生产数据');
    }
  } finally {
    if (sentinel) sentinel.stop();
    if (started) {
      step('第 6 步：销毁临时容器（含卷）');
      try {
        compose(['down', '-v', '--remove-orphans'], { timeout: 180_000 });
        console.log('  临时依赖已销毁');
      } catch (error) {
        console.error(`  ✗ 清理失败：${error instanceof Error ? error.message : String(error)}`);
        exitCode = exitCode || 4;
      }
    }
  }
  process.exit(exitCode);
}

void main();
