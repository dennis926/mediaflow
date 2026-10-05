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
 * 内容中心「AI 一键生成」（POST /contents/ai-draft）端到端。
 *
 * 走真实 HTTP + 真实数据库，但把 AI 提供方锁成 mock（MEDIAFLOW_SETTING_OVERRIDE_AI_PROVIDER），
 * 所以用例离线、可重复，不打真实模型、不消耗额度。
 *
 * 守的是「一键生成」的**闭环**：生成 → 产物可直接用于建内容 → 保存后 AI 标识自动带上，
 * 而不是只验接口返回 200。
 */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const credentialsReady = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

/** 测试数据的可识别前缀：teardown 只删自己造的行，绝不动真实内容。 */
const TITLE_PREFIX = '端到端测试_一键生成';

describe.skipIf(!credentialsReady)('内容中心：AI 一键生成', () => {
  let app: INestApplication;
  let token = '';
  const createdContentIds: string[] = [];

  beforeAll(async () => {
    process.env.PUBLISH_WORKER_ENABLED = 'false';
    // 离线锁：不打真实模型（mock 返回结构化占位，足以验证全链路）
    process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_PROVIDER = 'mock';
    process.env.MEDIAFLOW_SETTING_OVERRIDE_AI_MODEL = 'mock-model';
    process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_WORKER_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(201);
    token = login.body.data.accessToken;
  }, 60_000);

  afterAll(async () => {
    // 只清本次造的数据：先删引用再删主体，避免外键报错
    try {
      const dataSource = app?.get(DataSource);
      if (dataSource && createdContentIds.length > 0) {
        await dataSource.query('DELETE FROM content_variants WHERE content_id = ANY($1)', [createdContentIds]);
        await dataSource.query('DELETE FROM content_revisions WHERE content_id = ANY($1)', [createdContentIds]);
        await dataSource.query('DELETE FROM contents WHERE id = ANY($1)', [createdContentIds]);
      }
      // 清掉本次 mock 调用留下的 AI 用量记录，别污染真实成本统计
      if (dataSource) {
        await dataSource.query("DELETE FROM ai_generations WHERE task_type = 'content_generate' AND input_refs->>'topic' LIKE $1", [
          `%${TITLE_PREFIX}%`,
        ]);
      }
    } catch {
      // 清理失败不影响用例结论，但会在日志里留下痕迹
    }
    await app?.close();
  }, 60_000);

  it('给主题就能生成可直接使用的草案（标题/摘要/正文/标签）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/contents/ai-draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ topic: `${TITLE_PREFIX}：秋季肠道健康科普`, platform: 'xiaohongshu', tone: '亲切', keywords: ['膳食纤维'] })
      .expect(201);

    const data = response.body.data;
    expect(data.draft.title).toBeTruthy();
    expect(data.draft.body.length).toBeGreaterThan(50);
    expect(Array.isArray(data.draft.tags)).toBe(true);
    expect(data.generationId).toBeTruthy();
    expect(data.model).toBeTruthy();
    // 品牌资料命中情况要一并返回，便于界面解释「AI 为什么这么写」
    expect(Array.isArray(data.knowledgeUsed)).toBe(true);
  });

  it('生成结果不自动入库：调用后内容列表里不应出现它', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/contents/ai-draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ topic: `${TITLE_PREFIX}：不入库校验` })
      .expect(201);

    const title = response.body.data.draft.title;
    const list = await request(app.getHttpServer())
      .get('/api/contents')
      .query({ keyword: title })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(list.body.data.items).toHaveLength(0);
  });

  it('生成的草案可以走完整闭环：建内容 → 带 AI 标识 → 复核后可发布', async () => {
    const generated = await request(app.getHttpServer())
      .post('/api/contents/ai-draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ topic: `${TITLE_PREFIX}：闭环校验` })
      .expect(201);
    const draft = generated.body.data.draft;

    // ① 用草案建内容（前端「一键生成」后点保存就是这个请求）
    const created = await request(app.getHttpServer())
      .post('/api/contents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: draft.title, summary: draft.summary, body: draft.body, tags: draft.tags, aiFlagType: 'assisted' })
      .expect(201);
    createdContentIds.push(created.body.data.id);

    // ② AI 标识生效，正文追加显式标识（法定要求）
    expect(created.body.data.aiGenerated).toBe(true);
    expect(String(created.body.data.body)).toContain('（本文由 AI 辅助生成）');

    // ③ 未复核标识时发布会拦（这是 AI 内容合规闸门，不能被"一键生成"绕开）
    await request(app.getHttpServer())
      .post('/api/publish/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ contentId: created.body.data.id, platforms: ['wechat_mp'] })
      .expect(400);

    // ④ 复核后可建发布任务
    await request(app.getHttpServer())
      .patch(`/api/contents/${created.body.data.id}/ai-flag-check`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checked: true, note: '端到端测试' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/publish/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ contentId: created.body.data.id, platforms: ['wechat_mp'] })
      .expect(201);
  });

  it('主题过短时拒绝，避免把整篇内容交给一个含糊的主题', async () => {
    await request(app.getHttpServer())
      .post('/api/contents/ai-draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ topic: '短' })
      .expect(400);
  });

  it('未登录时拒绝（AI 调用要计费，不能匿名触发）', async () => {
    await request(app.getHttpServer()).post('/api/contents/ai-draft').send({ topic: `${TITLE_PREFIX}：匿名` }).expect(401);
  });
});
