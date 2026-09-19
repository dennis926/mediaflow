import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PublishQueueService } from '../src/publish/publish.queue';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';

/**
 * End-to-end flow against the real database and Redis:
 * login -> create content -> AI adapt -> create publish task -> read queue status -> notifications.
 */
/**
 * Credentials never live in the repository: export them before running the suite, e.g.
 *   E2E_ADMIN_EMAIL=you@example.com E2E_ADMIN_PASSWORD=... pnpm --filter @mediaflow/api test
 * Without them the suite is skipped (unit tests still run).
 */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const credentialsReady = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

const testStartedAt = new Date();
/** 端到端测试专用的队列与消费组，绝不与生产共用。 */
const E2E_STREAM = 'mediaflow:publish:tasks:e2e';
const E2E_GROUP = 'publish-workers-e2e';

describe.skipIf(!credentialsReady)('MediaFlow 端到端流程', () => {
  let app: INestApplication;
  let token = '';
  let contentId = '';
  /** 本次测试创建的发布任务 id：用于把队列里对应的消息一并清掉。 */
  let createdTaskIds: string[] = [];
  /** 测试前的队列长度，用于证明清理后队列没有增长。 */
  let queueLengthBefore = 0;

  beforeAll(async () => {
    process.env.PUBLISH_WORKER_ENABLED = 'false';
    /**
     * 端到端测试必须离线、可重复：用 MEDIAFLOW_SETTING_OVERRIDE_* 锁住 AI 提供方（它优先级高于数据库配置），
     * 否则测试会打真实模型接口——既慢又抖（实测 9~19 秒、偶发失败），还会消耗额度。
     */
    process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_PROVIDER = 'mock';
    process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_WORKER_ENABLED = 'false';
    process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_MODEL = 'mock-model';
    /**
     * 队列也必须隔离：E2E 跑在真实 Redis 上，如果和生产 Worker 共用同一条流，
     * 生产 Worker 会在「测试创建任务 → teardown 删任务」之间把消息消费掉，
     * 为随即被删掉的任务写通知与审计（幽灵记录）。用测试专用流+消费组，
     * 生产 Worker 完全看不到这些消息。
     */
    process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_STREAM_NAME = E2E_STREAM;
    process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_GROUP_NAME = E2E_GROUP;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    queueLengthBefore = await app.get(PublishQueueService).length();
  }, 60_000);

  afterAll(async () => {
    /**
     * 端到端测试跑的是真实数据库：把这次测试产生的 AI 用量记录清掉，
     * 否则会出现在「AI 用量」里，污染真实的成本统计（离线 mock 调用）。
     */
    try {
      const dataSource = app?.get(DataSource);
      if (dataSource) {
        // 端到端测试跑的是真实库：连带把自己造的内容/变体/任务清掉，别把测试数据留在业务列表里
        await dataSource.query(
          "DELETE FROM content_variants WHERE content_id IN (SELECT id FROM contents WHERE title LIKE '端到端测试内容%')",
        );
        await dataSource.query("DELETE FROM publish_tasks WHERE content_id IN (SELECT id FROM contents WHERE title LIKE '端到端测试内容%')");
        await dataSource.query("DELETE FROM content_reviews WHERE content_id IN (SELECT id FROM contents WHERE title LIKE '端到端测试内容%')");
        await dataSource.query("DELETE FROM contents WHERE title LIKE '端到端测试内容%'");
        await dataSource.query("DELETE FROM ai_generations WHERE provider = 'mock' AND created_at >= $1", [testStartedAt]);

        /**
         * Redis 流里也要清：任务行删掉后消息还在，生产 Worker 稍后会消费到孤儿消息，
         * 为已不存在的任务写通知与审计（幽灵记录）。只删本次任务 id 对应的消息，
         * 其他消息（含别人的未确认消息）不动。
         */
        const queue = app.get(PublishQueueService);
        const removal = await queue.removeByTaskIds(createdTaskIds);
        const queueLengthAfter = await queue.length();
        const leftover = await queue.removeByTaskIds(createdTaskIds);
        console.log(
          `[E2E] 队列清理（测试专用流 ${E2E_STREAM}）：本次任务 ${createdTaskIds.length} 个，` +
            `删除消息 ${removal.removed} 条（扫描 ${removal.inspected} 条），XLEN ${queueLengthBefore} → ${queueLengthAfter}，` +
            `残留 ${leftover.removed} 条`,
        );
        if (leftover.removed !== 0) {
          throw new Error(`E2E 队列清理失败：仍有 ${leftover.removed} 条本次测试的消息留在队列中`);
        }
        // 测试专用流本身也删掉，保证 Redis 里不留任何测试痕迹（生产流绝不触碰）。
        await app.get<Redis>(REDIS_CLIENT).call('DEL', E2E_STREAM);
      }
    } catch (error) {
      // 清理失败不改变测试结论，但必须显式暴露，避免静默留下脏数据
      console.error(`[E2E] 清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    await app?.close();
  });

  it('健康检查与鉴权', async () => {
    const health = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(health.body.code).toBe(0);

    await request(app.getHttpServer()).get('/api/contents').expect(401);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(201);
    expect(login.body.data.accessToken).toBeTruthy();
    token = login.body.data.accessToken as string;
  });

  it('创建内容（AI 标识与合规后缀）', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/contents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: `端到端测试内容 ${Date.now()}`, body: '这是一段用于集成测试的正文。', tags: ['测试'], aiFlagType: 'assisted' })
      .expect(201);

    contentId = created.body.data.id as string;
    expect(created.body.data.aiGenerated).toBe(true);
    expect(String(created.body.data.body)).toContain('（本文由 AI 辅助生成）');
  });

  it('AI 多平台适配生成版本', async () => {
    const adapted = await request(app.getHttpServer())
      .post(`/api/contents/${contentId}/ai-adapt`)
      .set('Authorization', `Bearer ${token}`)
      .send({ platforms: ['wechat_mp', 'xiaohongshu'], tone: '通俗易懂' })
      .expect(201);

    expect(adapted.body.data.variants.length).toBe(2);
    expect(adapted.body.data.generationId).toBeTruthy();

    const variants = await request(app.getHttpServer())
      .get(`/api/contents/${contentId}/variants`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(variants.body.data.length).toBe(2);
  });

  it('AI 内容未复核标识时拒绝发布', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/publish/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ contentId, platforms: ['wechat_mp'] })
      .expect(400);
    expect(response.body.code).toBe(40000);
  });

  it('复核标识后可创建发布任务并查询状态', async () => {
    await request(app.getHttpServer())
      .patch(`/api/contents/${contentId}/ai-flag-check`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checked: true, note: '集成测试' })
      .expect(200);

    const created = await request(app.getHttpServer())
      .post('/api/publish/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ contentId, platforms: ['wechat_mp', 'zhihu'] })
      .expect(201);
    expect(created.body.data.length).toBe(2);
    createdTaskIds.push(...(created.body.data as Array<{ id: string }>).map((task) => task.id));
    const taskId = created.body.data[0].id as string;

    const detail = await request(app.getHttpServer())
      .get(`/api/publish/tasks/${taskId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(['pending', 'scheduled', 'publishing', 'published', 'manual_required']).toContain(detail.body.data.status);

    const list = await request(app.getHttpServer())
      .get('/api/publish/tasks?pageSize=5')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data.meta.total).toBeGreaterThan(0);
  });

  it('日历、通知、数据中心与配置接口可用', async () => {
    const calendar = await request(app.getHttpServer())
      .get('/api/publish/calendar')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(calendar.body.data).toHaveLength(7);

    const notifications = await request(app.getHttpServer())
      .get('/api/notifications?pageSize=5')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(notifications.body.data.meta).toBeTruthy();

    const overview = await request(app.getHttpServer())
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(overview.body.data.contents).toBeGreaterThan(0);

    const settings = await request(app.getHttpServer())
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(settings.body.data.length).toBeGreaterThanOrEqual(3);
    // Secrets must never be returned in clear text.
    const aiKey = settings.body.data.flatMap((group: { items: Array<{ key: string; value: string }> }) => group.items).find(
      (item: { key: string }) => item.key === 'AI_API_KEY',
    );
    expect(aiKey.value.startsWith('sk-')).toBe(false);
  });

  it('软删除后内容不可见', async () => {
    await request(app.getHttpServer())
      .delete(`/api/contents/${contentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/contents/${contentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
