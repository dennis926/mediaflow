import { INestApplication, ValidationPipe } from '@nestjs/common';
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
  /** 用某个令牌切到指定工作区，返回该工作区的令牌。 */
  switchWorkspace(token: string, workspaceId: string): Promise<string>;
  cleanup(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(titlePrefix: string, options: { requireApproval?: boolean } = {}): Promise<E2eHarness> {
  // Highest-priority settings channel: overrides the database for this process only.
  process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_PROVIDER = 'mock';
  process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_MODEL = 'mock-model';
  process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_WORKER_ENABLED = 'false';
  process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_STREAM_NAME = E2E_STREAM;
  process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_GROUP_NAME = E2E_GROUP;
  process.env.MEDIAFLOW_SETTING_OVERRIDE_REQUIRE_CONTENT_APPROVAL = options.requireApproval === false ? 'false' : 'true';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const dataSource = app.get(DataSource);

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
      // 测试工作区（先删成员再删工作区；users.workspace_id 对 workspaces 是 CASCADE，测试账号已先删）
      for (const workspaceId of harness.createdWorkspaceIds) {
        await dataSource.query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
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
