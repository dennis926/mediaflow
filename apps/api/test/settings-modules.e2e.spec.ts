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
 * 设置中心四个独立模块的端到端：
 *   ① AI 配置（/ai-config）：测试连接 → 获取模型 → 选默认模型，三步闭环；
 *   ② 角色与权限（/permissions）：勾选表格保存矩阵、角色显示名可改、可恢复出厂；
 *   ③ 通知渠道（/channels/notify）：开关式，可同时开启多个渠道；
 *   ④ 平台密钥（/channels/platform）：开关式，打开才填凭据。
 *
 * 全部走真实 HTTP + 真实数据库，AI 提供方锁成 mock 所以离线可跑。
 * 守的是"用户点得动、结果真的落库"——不是接口返回 200 就算过。
 */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const credentialsReady = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

describe.skipIf(!credentialsReady)('设置中心：AI 配置 / 权限 / 通知 / 平台密钥', () => {
  let app: INestApplication;
  let token = '';
  let dataSource: DataSource;
  /** 用例会改这些配置，跑完必须还原，避免污染后续用例与本地环境。 */
  const restore: Array<{ key: string; value: string | null }> = [];

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.PUBLISH_WORKER_ENABLED = 'false';
    process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_WORKER_ENABLED = 'false';
    process.env.MONITOR_ENABLED = 'false';

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

    dataSource = app.get(DataSource);
    // 记录原值：只记录本次会动的键
    const keys = ['PERMISSION_MATRIX', 'ROLE_LABELS', 'NOTIFY_CHANNEL_WEBHOOK', 'PLATFORM_CHANNEL_ZHIHU'];
    for (const key of keys) {
      const rows = await dataSource.query('SELECT value FROM system_settings WHERE key = $1', [key]);
      restore.push({ key, value: rows[0]?.value ?? null });
    }
  }, 90_000);

  afterAll(async () => {
    try {
      // 还原被改动的配置，避免影响其它用例
      for (const item of restore) {
        if (item.value === null) {
          await dataSource?.query('DELETE FROM system_settings WHERE key = $1', [item.key]);
        } else {
          await dataSource?.query('UPDATE system_settings SET value = $2 WHERE key = $1', [item.key, item.value]);
        }
      }
    } finally {
      await app?.close();
    }
  }, 60_000);

  describe('① AI 配置', () => {
    it('返回当前配置与预置供应商目录（密钥打码）', async () => {
      const res = await request(app.getHttpServer()).get('/api/ai-config').set(auth()).expect(200);
      const view = res.body.data;
      expect(view.provider).toBeTruthy();
      expect(Array.isArray(view.catalog)).toBe(true);
      expect(view.catalog.length, '预置供应商目录不能为空，否则界面上选不了供应商').toBeGreaterThan(0);
      // 打码：绝不能把明文密钥吐给前端
      expect(String(view.apiKeyMasked)).not.toMatch(/^sk-[A-Za-z0-9]{20,}$/);
    });

    it('测试连接：离线占位也必须给出 ok 与模型名', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/ai-config/test')
        .set(auth())
        .send({ provider: 'mock' })
        .expect(201);
      expect(res.body.data.ok).toBe(true);
      expect(res.body.data.model).toBeTruthy();
      expect(typeof res.body.data.latencyMs).toBe('number');
    });

    it('获取模型：mock 供应商返回可勾选的模型列表', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/ai-config/models')
        .set(auth())
        .send({ provider: 'mock' })
        .expect(201);
      expect(res.body.data.ok).toBe(true);
      expect(res.body.data.models.length).toBeGreaterThan(0);
    });

    it('保存默认模型：写入后 view 立刻反映新值', async () => {
      const before = await request(app.getHttpServer()).get('/api/ai-config').set(auth()).expect(200);
      const originalProvider = before.body.data.provider;
      const originalModel = before.body.data.model;

      const res = await request(app.getHttpServer())
        .put('/api/ai-config/default')
        .set(auth())
        .send({ provider: 'mock', model: 'mock-model', models: ['mock-model'] })
        .expect(200);
      expect(res.body.data.provider).toBe('mock');
      expect(res.body.data.model).toBe('mock-model');

      // 还原，避免把本地环境锁死在 mock
      await request(app.getHttpServer())
        .put('/api/ai-config/default')
        .set(auth())
        .send({ provider: originalProvider, model: originalModel })
        .expect(200);
    });

    it('不选模型就保存 → 400（模型是必填项）', async () => {
      await request(app.getHttpServer())
        .put('/api/ai-config/default')
        .set(auth())
        .send({ provider: 'mock', model: '' })
        .expect(400);
    });

    it('未登录访问 → 401', async () => {
      await request(app.getHttpServer()).get('/api/ai-config').expect(401);
    });
  });

  describe('② 角色与权限', () => {
    it('返回分组后的权限表与角色列表', async () => {
      const res = await request(app.getHttpServer()).get('/api/permissions').set(auth()).expect(200);
      const view = res.body.data;
      expect(view.roles.length, '五个内置角色必须都在').toBeGreaterThanOrEqual(5);
      expect(view.groups.length, '权限必须按业务分组').toBeGreaterThan(0);
      const total = view.groups.reduce((sum: number, g: { capabilities: unknown[] }) => sum + g.capabilities.length, 0);
      expect(total, '能力点不能被漏掉').toBeGreaterThanOrEqual(17);
      // 每项都要有中文名，界面上不能出现裸代码
      for (const group of view.groups) {
        for (const capability of group.capabilities) expect(capability.label).toBeTruthy();
      }
    });

    it('勾选保存后真的落库，并且读回一致', async () => {
      const before = await request(app.getHttpServer()).get('/api/permissions').set(auth()).expect(200);
      const matrix: Record<string, string[]> = {};
      for (const group of before.body.data.groups) {
        for (const capability of group.capabilities) matrix[capability.key] = capability.roles;
      }
      // 给 editor 增加 content.review 权限
      matrix['content.review'] = [...new Set([...(matrix['content.review'] ?? []), 'editor'])];

      const saved = await request(app.getHttpServer())
        .put('/api/permissions/matrix')
        .set(auth())
        .send({ matrix })
        .expect(200);

      const review = saved.body.data.groups
        .flatMap((g: { capabilities: Array<{ key: string; roles: string[] }> }) => g.capabilities)
        .find((c: { key: string }) => c.key === 'content.review');
      expect(review.roles).toContain('editor');

      // 数据库里也要有（不是只在内存里改了）
      const rows = await dataSource.query("SELECT value FROM system_settings WHERE key = 'PERMISSION_MATRIX'");
      expect(String(rows[0]?.value)).toContain('content.review');
    });

    it('拒绝未知角色代码（防止手写错值悄悄生效）', async () => {
      await request(app.getHttpServer())
        .put('/api/permissions/matrix')
        .set(auth())
        .send({ matrix: { 'content.write': ['owner', 'not-a-role'] } })
        .expect(400);
    });

    it('角色显示名可改，且改的是显示名不是代码', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/permissions/roles')
        .set(auth())
        .send({ labels: { admin: '运营主管' } })
        .expect(200);
      const admin = res.body.data.roles.find((r: { code: string }) => r.code === 'admin');
      expect(admin.label).toBe('运营主管');
      expect(admin.code, '角色代码不变，只是显示名改了').toBe('admin');
    });

    it('显示名超长 → 400', async () => {
      await request(app.getHttpServer())
        .put('/api/permissions/roles')
        .set(auth())
        .send({ labels: { admin: '一'.repeat(21) } })
        .expect(400);
    });

    it('恢复出厂设置后回到默认矩阵', async () => {
      const res = await request(app.getHttpServer()).put('/api/permissions/reset').set(auth()).send({}).expect(200);
      const review = res.body.data.groups
        .flatMap((g: { capabilities: Array<{ key: string; roles: string[] }> }) => g.capabilities)
        .find((c: { key: string }) => c.key === 'content.review');
      expect(review.roles).not.toContain('editor');
      expect(res.body.data.roles.find((r: { code: string }) => r.code === 'admin').label).toBe('管理员');
    });
  });

  describe('③ 通知渠道（开关 + 勾选）', () => {
    it('返回渠道开关与各自字段', async () => {
      const res = await request(app.getHttpServer()).get('/api/channels/notify').set(auth()).expect(200);
      const view = res.body.data;
      expect(view.channels.length, '至少要有群机器人与邮件两个渠道').toBeGreaterThanOrEqual(2);
      for (const channel of view.channels) {
        expect(typeof channel.enabled).toBe('boolean');
        expect(channel.label).toBeTruthy();
      }
      expect(view.globals.length).toBeGreaterThan(0);
    });

    it('可以同时开启两个渠道（这正是"勾选式"要保证的）', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/channels/notify')
        .set(auth())
        .send({ enabled: { webhook: true, email: true } })
        .expect(200);
      const webhook = res.body.data.channels.find((c: { code: string }) => c.code === 'webhook');
      const email = res.body.data.channels.find((c: { code: string }) => c.code === 'email');
      expect(webhook.enabled).toBe(true);
      expect(email.enabled, '开启第二个渠道不能把第一个关掉').toBe(true);
    });

    it('关闭渠道后配置字段仍然返回（下次打开不用重填）', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/channels/notify')
        .set(auth())
        .send({ enabled: { webhook: false }, values: { NOTIFY_WEBHOOK_URL: 'https://example.com/hook' } })
        .expect(200);
      const webhook = res.body.data.channels.find((c: { code: string }) => c.code === 'webhook');
      expect(webhook.enabled).toBe(false);
      const url = webhook.fields.find((f: { key: string }) => f.key === 'NOTIFY_WEBHOOK_URL');
      expect(url.value, '关掉开关不能清空已填的地址').toBe('https://example.com/hook');
    });

    it('拒绝未知渠道代码', async () => {
      await request(app.getHttpServer())
        .put('/api/channels/notify')
        .set(auth())
        .send({ enabled: { 'not-a-channel': true } })
        .expect(400);
    });
  });

  describe('④ 平台密钥（开关 + 勾选）', () => {
    it('返回八个平台通道，且无 API 的平台标注为插件发布', async () => {
      const res = await request(app.getHttpServer()).get('/api/channels/platform').set(auth()).expect(200);
      const view = res.body.data;
      expect(view.channels.length, '主流平台都要在列表里').toBeGreaterThanOrEqual(8);
      const zhihu = view.channels.find((c: { code: string }) => c.code === 'zhihu');
      expect(zhihu, '知乎必须出现（无 API 也要让用户看得到）').toBeTruthy();
      expect(zhihu.fields.length, '知乎没有官方发布 API，不该要凭据').toBe(0);
      const wechat = view.channels.find((c: { code: string }) => c.code === 'wechat_mp');
      expect(wechat.fields.length, '公众号需要 AppID/AppSecret 用于拉数据').toBeGreaterThan(0);
    });

    it('开启平台开关并落库', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/channels/platform')
        .set(auth())
        .send({ enabled: { zhihu: true, toutiao: true } })
        .expect(200);
      const codes = res.body.data.channels.filter((c: { enabled: boolean }) => c.enabled).map((c: { code: string }) => c.code);
      expect(codes).toContain('zhihu');
      expect(codes).toContain('toutiao');

      const rows = await dataSource.query("SELECT value FROM system_settings WHERE key = 'PLATFORM_CHANNEL_ZHIHU'");
      expect(String(rows[0]?.value)).toBe('true');
    });

    it('未登录访问 → 401', async () => {
      await request(app.getHttpServer()).get('/api/channels/platform').expect(401);
    });
  });
});
