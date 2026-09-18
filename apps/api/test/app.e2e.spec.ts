import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
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

describe.skipIf(!credentialsReady)('MediaFlow 端到端流程', () => {
  let app: INestApplication;
  let token = '';
  let contentId = '';

  beforeAll(async () => {
    process.env.PUBLISH_WORKER_ENABLED = 'false';
    /**
     * 端到端测试必须离线、可重复：用 MEDIAFLOW_SETTING_OVERRIDE_* 锁住 AI 提供方（它优先级高于数据库配置），
     * 否则测试会打真实模型接口——既慢又抖（实测 9~19 秒、偶发失败），还会消耗额度。
     */
    process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_PROVIDER = 'mock';
    process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_WORKER_ENABLED = 'false';
    process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_MODEL = 'mock-model';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
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
      }
    } catch {
      // 清理失败不影响测试结论
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
