import { INestApplication, ValidationPipe } from '@nestjs/common';
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BUSINESS_TABLES } from '../../src/modules/workspace/workspace-purge.service';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PublishQueueService } from '../../src/publish/publish.queue';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';

/**
 * Shared harness for the integration suites.
 *
 * Every suite runs against the real database and Redis, so it must be hermetic:
 * 1. AI is pinned to the offline mock provider (no external calls, no quota spend).
 * 2. The publish worker is disabled and the queue is a suite-private stream/group, so the
 *    production worker never consumes test messages (it would otherwise act on tasks the
 *    suite is about to delete - see docs/DECISION-E2E隔离.md).
 * 3. Teardown removes every row the suite created, identified by a title prefix.
 */
export const E2E_STREAM = 'mediaflow:publish:tasks:e2e';
export const E2E_GROUP = 'publish-workers-e2e';

export interface E2eHarness {
  app: INestApplication;
  dataSource: DataSource;
  queue: PublishQueueService;
  redis: Redis;
  titlePrefix: string;
  createdTaskIds: string[];
  createdUserIds: string[];
  createdWorkspaceIds: string[];
  login(email: string, password: string): Promise<string>;
  createUser(input: { roleCodes: string[]; displayName?: string }): Promise<{ id: string; email: string; password: string; token: string }>;
  createWorkspace(name: string): Promise<string>;
  /**
   * 默认工作区 id。
   * **测试里绝不能硬编码它**：种子用随机 UUID 建默认工作区，每次安装都不同
   * （生产是 2222…，而隔离的临时库是别的值）。需要引用默认工作区时一律走这个方法。
   */
  defaultWorkspaceId(): Promise<string>;
  /** 用某个令牌切到指定工作区，返回该工作区的令牌。 */
  switchWorkspace(token: string, workspaceId: string): Promise<string>;
  cleanup(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 跑 E2E 前的**硬检查**：默认工作区必须是 active。
 *
 * 背景：E2E 直接跑在生产库上（见 docs/TECHDEBT-E2E隔离.md）。2026-09-19 的一次用例失误
 * 把默认工作区软删了，导致整套用例大面积 404。此后每个套件在启动应用**之前**先做这项检查：
 * 默认工作区不是 active 就直接拒绝运行，避免"在坏地基上继续跑测试"把问题放大。
 *
 * 用独立的 pg 连接（不启动 Nest 应用）以便尽早失败。绕过方式（仅本地排障）：E2E_SKIP_PRECONDITION=1。
 */
export async function assertDefaultWorkspaceIsActive(): Promise<void> {
  if (process.env.E2E_SKIP_PRECONDITION === '1') return;
  const { Client } = await import('pg');
  const client = new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'mediaflow',
    user: process.env.DB_USER ?? 'mediaflow',
    password: process.env.DB_PASSWORD ?? 'mediaflow_dev',
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT name, status FROM workspaces WHERE slug = 'default' ORDER BY created_at LIMIT 1",
    );
    const row = rows[0] as { name: string; status: string } | undefined;
    if (!row) {
      throw new Error('E2E 拒绝运行：找不到默认工作区（slug=default），请先执行 pnpm seed。');
    }
    if (row.status !== 'active') {
      throw new Error(
        `E2E 拒绝运行：默认工作区「${row.name}」当前状态为 ${row.status}（应为 active）。` +
          '请先用 POST /api/workspaces/:id/restore（或直接把 workspaces.status 改回 active）恢复后再跑测试。',
      );
    }
  } finally {
    await client.end();
  }
}

export const TEST_ARTIFACT_PATTERNS = ['e2e-%', 'E2E%', 'concurrent-%', 'ok.png'] as const;

/**
 * Sweep residue left behind by an earlier run that crashed or was killed (teardown never ran).
 * Only touches rows that look like this test-suite's own artifacts AND whose file is missing —
 * never a real upload. Runs before each suite so residue cannot accumulate unnoticed.
 */
export async function sweepStaleTestResidue(dataSource: DataSource, log: (message: string) => void): Promise<void> {
  const rows: Array<{ id: string; stored_name: string; original_name: string }> = await dataSource.query(
    `SELECT id, stored_name, original_name FROM media_assets
      WHERE original_name LIKE 'e2e-%' OR original_name IN ('ok.png') OR original_name LIKE 'concurrent-%'
         OR group_name LIKE 'E2E%'`,
  );
  const mediaDir = join(process.cwd(), '../../uploads/media');
  const orphanIds: string[] = [];
  for (const row of rows) {
    if (!existsSync(join(mediaDir, row.stored_name))) orphanIds.push(row.id);
  }
  if (orphanIds.length > 0) {
    await dataSource.query('DELETE FROM media_assets WHERE id = ANY($1)', [orphanIds]);
  }
  const tmpDir = join(process.cwd(), '../../uploads/tmp');
  let removedTmp = 0;
  if (existsSync(tmpDir)) {
    for (const file of readdirSync(tmpDir)) {
      const full = join(tmpDir, file);
      const stat = statSync(full);
      if (Date.now() - stat.mtimeMs > 3600_000) {
        unlinkSync(full);
        removedTmp += 1;
      }
    }
  }
  if (orphanIds.length > 0 || removedTmp > 0) {
    log(`[E2E] 已清扫上一次运行的残留：素材孤儿行 ${orphanIds.length} 条、临时文件 ${removedTmp} 个`);
  }
}

export async function createHarness(titlePrefix: string, options: { requireApproval?: boolean } = {}): Promise<E2eHarness> {
  // 任何套件在启动应用之前都先过这道闸门
  await assertDefaultWorkspaceIsActive();

  // Highest-priority settings channel: overrides the database for this process only.
  process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_PROVIDER = 'mock';
  process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_MODEL = 'mock-model';
  process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_WORKER_ENABLED = 'false';
  process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_STREAM_NAME = E2E_STREAM;
  process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_GROUP_NAME = E2E_GROUP;
  process.env.MEDIAFLOW_SETTING_OVERRIDE_REQUIRE_CONTENT_APPROVAL = options.requireApproval === false ? 'false' : 'true';
  /**
   * 关掉运维巡检的定时器。
   *
   * `enabled` 只在 `tick()` 里判断，HTTP 入口 `/api/ops/monitor/run` 不受影响，
   * 因此关掉它不影响任何用例主动触发巡检。
   *
   * 不关会有一个真实的竞态：套件在 beforeAll 里清空 `ops:monitor:*`（含
   * `ops:monitor:last` 上次运行时间），于是应用的每分钟 cron 会在下一个分钟边界
   * 立刻执行 runAll()，抢先用掉告警冷却槽（`ops:monitor:alerted:*`）。等用例自己
   * 调 `/api/ops/monitor/run` 时，部分检查项已被判定为「冷却中」，`emitted` 缺项，
   * 用例随机失败。用例跑到一半才失败、重跑又过，正是这个竞态的特征。
   */
  process.env.MEDIAFLOW_SETTING_OVERRIDE_MONITOR_ENABLED = 'false';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const dataSource = app.get(DataSource);
  // A crashed or killed run skips teardown, so sweep its leftovers before the suite starts.
  await sweepStaleTestResidue(dataSource, (message) => console.warn(message));

  // 上一次异常退出可能留下测试账号：清掉 10 分钟前的残留（10 分钟内的属于正在运行的套件）。
  await dataSource.query(
    "DELETE FROM user_roles WHERE users_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%@example.com' AND created_at < now() - interval '10 minutes')",
  );
  await dataSource.query(
    "DELETE FROM workspace_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%@example.com' AND created_at < now() - interval '10 minutes')",
  );
  await dataSource.query("DELETE FROM users WHERE email LIKE 'e2e-%@example.com' AND created_at < now() - interval '10 minutes'");
  const queue = app.get(PublishQueueService);
  const redis = app.get<Redis>(REDIS_CLIENT);
  const startedAt = new Date();

  const harness: E2eHarness = {
    app,
    dataSource,
    queue,
    redis,
    titlePrefix,
    createdTaskIds: [],
    createdUserIds: [],
    createdWorkspaceIds: [],

    async login(email: string, password: string): Promise<string> {
      const response = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password }).expect(201);
      return response.body.data.accessToken as string;
    },

    async createUser({ roleCodes, displayName = '端到端测试账号' }) {
      const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.com`;
      const password = 'E2ePass123';
      const owner = await harness.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
      const created = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${owner}`)
        .send({ email, displayName, password, roleCodes })
        .expect(201);
      // POST /users 返回 { data: { user: {...}, temporaryPassword? } }，取错路径会静默留下残留账号。
      const payload = created.body.data as { user?: { id?: string }; id?: string };
      const id = payload.user?.id ?? payload.id;
      if (!id) throw new Error(`创建测试账号失败：响应中没有用户 id（${JSON.stringify(created.body).slice(0, 200)}）`);
      harness.createdUserIds.push(id);
      return { id, email, password, token: await harness.login(email, password) };
    },

    async defaultWorkspaceId(): Promise<string> {
      const rows = await dataSource.query("SELECT id FROM workspaces WHERE slug = 'default' ORDER BY created_at LIMIT 1");
      if (!rows[0]?.id) throw new Error('默认工作区不存在（种子未跑？）');
      return rows[0].id as string;
    },

    async createWorkspace(name: string): Promise<string> {
      const owner = await harness.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
      const created = await request(app.getHttpServer())
        .post('/api/workspaces')
        .set('Authorization', `Bearer ${owner}`)
        .send({ name })
        .expect(201);
      const payload = created.body.data as { workspace?: { id?: string }; id?: string };
      const id = payload.workspace?.id ?? payload.id;
      if (!id) throw new Error(`创建工作区失败：响应中没有 id（${JSON.stringify(created.body).slice(0, 200)}）`);
      harness.createdWorkspaceIds.push(id);
      return id;
    },

    async switchWorkspace(token: string, workspaceId: string): Promise<string> {
      const response = await request(app.getHttpServer())
        .post('/api/auth/switch-workspace')
        .set('Authorization', `Bearer ${token}`)
        .send({ workspaceId });
      if (response.status >= 400) {
        throw new Error(`切换工作区失败（${response.status}）：${JSON.stringify(response.body).slice(0, 200)}`);
      }
      return response.body.data.accessToken as string;
    },

    async cleanup(): Promise<void> {
      const scope = `(SELECT id FROM contents WHERE title LIKE '${titlePrefix}%')`;
      await dataSource.query(`DELETE FROM content_variants WHERE content_id IN ${scope}`);
      await dataSource.query(`DELETE FROM publish_tasks WHERE content_id IN ${scope}`);
      await dataSource.query(`DELETE FROM content_reviews WHERE content_id IN ${scope}`);
      await dataSource.query(`DELETE FROM content_revisions WHERE content_id IN ${scope}`);
      await dataSource.query("DELETE FROM contents WHERE title LIKE $1", [`${titlePrefix}%`]);
      await dataSource.query("DELETE FROM ai_generations WHERE provider = 'mock' AND created_at >= $1", [startedAt]);
      for (const userId of harness.createdUserIds) {
        // user_roles is TypeORM's default-named join table (users_id / roles_id).
        await dataSource.query('DELETE FROM user_roles WHERE users_id = $1', [userId]);
        await dataSource.query('DELETE FROM workspace_members WHERE user_id = $1', [userId]);
        await dataSource.query('DELETE FROM users WHERE id = $1', [userId]);
      }
      /**
       * 上传的素材与导出产物也要清：此前只删业务表，导致 uploads/media 与 uploads/exports 越攒越多
       * （2026-09-21 一次性清掉 6 个残留素材 + 3 个导出任务 + 9 个空目录，故在这里补齐）。
       * 只处理"本次测试开始之后创建"的行，避免碰到真实数据。
       */
      const mediaRows: Array<{ id: string; stored_name: string }> = await dataSource.query(
        'SELECT id, stored_name FROM media_assets WHERE created_at >= $1',
        [startedAt],
      );
      const mediaDir = join(process.cwd(), '../../uploads/media');
      for (const row of mediaRows) {
        const file = join(mediaDir, row.stored_name);
        try {
          if (existsSync(file)) unlinkSync(file);
        } catch {
          // 文件已不在也无所谓，继续删行
        }
      }
      if (mediaRows.length > 0) {
        await dataSource.query('DELETE FROM media_assets WHERE created_at >= $1', [startedAt]);
      }

      // 导出任务与产物目录（本次运行创建的）
      const exportJobs: Array<{ workspace_id: string }> = await dataSource.query(
        'SELECT workspace_id FROM workspace_export_jobs WHERE created_at >= $1',
        [startedAt],
      );
      if (exportJobs.length > 0) {
        await dataSource.query('DELETE FROM workspace_export_jobs WHERE created_at >= $1', [startedAt]);
        for (const workspaceId of new Set(exportJobs.map((row) => row.workspace_id))) {
          const dir = join(process.cwd(), '../../uploads/exports', workspaceId);
          try {
            if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          } catch {
            // 目录清理失败不影响测试结论
          }
        }
      }

      /**
       * 测试工作区：按生产 purge 的同一份清单清理，最后删工作区行。
       *
       * 为什么不能只 `DELETE FROM workspaces`：`system_settings` / `quotas` / `roles` 这些表
       * **没有指向 workspaces 的外键**，只删工作区行会在临时库里留下孤儿行。以前这没被
       * 发现是因为没人检查；2026-10-01 给监控加了孤儿行判定后立刻暴露出来——生产库上
       * 同样的遗漏导致了 18 条 system_settings 孤儿（站点名显示成上一个工作区的配置）。
       * 这里复用 BUSINESS_TABLES，保证"测试清理"和"生产 purge"行为一致。
       */
      for (const workspaceId of harness.createdWorkspaceIds) {
        for (const table of BUSINESS_TABLES) {
          await dataSource.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
        }
        await dataSource.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      }
      // Queue hygiene: drop this run's messages, then the private stream itself.
      await queue.removeByTaskIds(harness.createdTaskIds);
      await redis.call('DEL', E2E_STREAM);
    },

    async close(): Promise<void> {
      await app.close();
    },
  };

  return harness;
}

/** True when E2E credentials are present; suites skip themselves otherwise. */
export const e2eCredentialsReady = Boolean(process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD);
