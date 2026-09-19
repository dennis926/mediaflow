import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 第 6 项（监控补齐）的**真实触发**验证：六类告警逐个制造真实条件，
 * 再用运维入口跑一次巡检，断言命中、告警文案四要素、以及 error 级落审计。
 *
 * 阈值通过最高优先级的测试覆盖通道收紧（例如队列阈值设成 1 条、磁盘设成 1%），
 * 因此无需真的把磁盘写满或把队列堆到 100 条——但每条信号的**来源都是真实的**
 * （真实 Redis 流、真实数据库行、真实登录失败、真实 statfs）。
 */
const PREFIX = 'E2E监控';
/** 巡检返回的检查键（emitted 里是键，不是通知 type） */
const MONITOR_KEYS = [
  'queue_length',
  'queue_pending_age',
  'publish_failure_rate',
  'login_failures',
  'upload_disk',
  'ai_token_quota',
];
const MONITOR_TYPES = [
  'ops.monitor.queue_length',
  'ops.monitor.queue_pending_age',
  'ops.monitor.publish_failure_rate',
  'ops.monitor.login_failures',
  'ops.monitor.upload_disk',
  'ops.monitor.ai_token_quota',
];

describe.skipIf(!e2eCredentialsReady)('第 6 项：监控告警真实触发', () => {
  let h: E2eHarness;
  let token = '';
  let tenantId = '';
  let workspaceId = '';
  let probeGenerationId = '';
  let runResult: {
    checks: Array<{ key: string; current: number; threshold: number; triggered: boolean; level: string; detail: string; link: string }>;
    emitted: string[];
    suppressed: string[];
  };

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();

  beforeAll(async () => {
    // 测试覆盖通道：把阈值收紧到"真实但轻微"的条件即可命中
    Object.assign(process.env, {
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_QUEUE_LENGTH_THRESHOLD: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_PENDING_AGE_SECONDS: '0',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_FAILURE_RATE_PERCENT: '10',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_FAILURE_MIN_SAMPLE: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_LOGIN_FAIL_THRESHOLD: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_LOGIN_FAIL_WINDOW_MINUTES: '5',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_DISK_USED_PERCENT: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_AI_QUOTA_PERCENT: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_ALERT_COOLDOWN_MINUTES: '1',
      MEDIAFLOW_SETTING_OVERRIDE_AI_DAILY_TOKEN_QUOTA: '10',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_OPS_BASE_URL: 'https://auto.liangyijianye.cn',
    });

    h = await createHarness(PREFIX, { requireApproval: false });
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const scope = await h.dataSource.query("SELECT id, tenant_id FROM workspaces WHERE slug = 'default' ORDER BY created_at LIMIT 1");
    workspaceId = scope[0].id as string;
    tenantId = scope[0].tenant_id as string;

    // 冷却与登录失败窗口清零：保证本次一定发出告警
    for (const key of await h.redis.keys('ops:monitor:*')) await h.redis.del(key);
    await h.redis.del('auth:fail:window');

    // —— 条件 1+2：队列积压 + 未确认消息滞留（真实入队、真实不 ack）——
    await h.queue.ensureGroup();
    for (let index = 0; index < 3; index += 1) await h.queue.enqueue(randomUUID());
    await h.queue.read('e2e-monitor-consumer', 1, 300);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // —— 条件 3：近 1 小时失败率（真实任务行 + 置为 failed）——
    const content = await request(server())
      .post('/api/contents')
      .set(auth())
      .send({ title: `${PREFIX} 失败率探针 ${Date.now()}`, body: '正文' })
      .expect(201);
    const contentId = content.body.data.id as string;
    const tasks = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['wechat_mp', 'zhihu', 'douyin'] })
      .expect(201);
    h.createdTaskIds.push(...(tasks.body.data as Array<{ id: string }>).map((task) => task.id));
    await h.dataSource.query(
      "UPDATE publish_tasks SET status = 'failed', finished_at = now(), error_message = 'E2E 监控探针' WHERE content_id = $1",
      [contentId],
    );

    // —— 条件 4：登录失败激增（真实调用登录接口，密码故意错误）——
    for (let index = 0; index < 2; index += 1) {
      await request(server())
        .post('/api/auth/login')
        .send({ email: process.env.E2E_ADMIN_EMAIL, password: `wrong-password-${index}` });
    }

    // —— 条件 6：AI 当日配额（真实用量行 + 极小配额）——
    const probe = await h.dataSource.query(
      `INSERT INTO ai_generations (id, tenant_id, workspace_id, provider, model, task_type, status, prompt, tokens_input, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'mock', 'mock-model', 'e2e-monitor-probe', 'success', '监控探针', 100, now(), now())
       RETURNING id`,
      [tenantId, workspaceId],
    );
    probeGenerationId = probe[0].id as string;

    // —— 触发巡检（真实 HTTP 入口）——
    const response = await request(server()).post('/api/ops/monitor/run').set(auth()).expect(201);
    runResult = response.body.data;
  }, 120_000);

  afterAll(async () => {
    // 清掉本次监控产生的通知与探针数据（审计按设计只追加，不删）
    await h?.dataSource.query("DELETE FROM notifications WHERE type LIKE 'ops.monitor.%'").catch(() => undefined);
    if (probeGenerationId) {
      await h?.dataSource.query('DELETE FROM ai_generations WHERE id = $1', [probeGenerationId]).catch(() => undefined);
    }
    for (const key of (await h?.redis.keys('ops:monitor:*')) ?? []) await h.redis.del(key);
    await h?.redis.del('auth:fail:window');
    await h?.cleanup();
    await h?.close();
  });

  it('1-6. 六类信号全部命中（真实条件，非模拟）', () => {
    const byKey = new Map(runResult.checks.map((check) => [check.key, check]));
    expect(runResult.checks).toHaveLength(6);

    const queue = byKey.get('queue_length');
    expect(queue?.triggered).toBe(true);
    expect(queue?.current).toBeGreaterThanOrEqual(3);

    const pending = byKey.get('queue_pending_age');
    expect(pending?.triggered).toBe(true);
    expect(pending?.level).toBe('error');

    const failure = byKey.get('publish_failure_rate');
    expect(failure?.triggered).toBe(true);
    expect(failure?.current).toBe(100); // 3 条全部 failed

    const login = byKey.get('login_failures');
    expect(login?.triggered).toBe(true);
    expect(login?.current).toBeGreaterThanOrEqual(2);

    const disk = byKey.get('upload_disk');
    expect(disk?.triggered).toBe(true);
    expect(disk?.current).toBeGreaterThan(1);

    const quota = byKey.get('ai_token_quota');
    expect(quota?.triggered).toBe(true);
    expect(quota?.current).toBeGreaterThan(1);
  });

  it('六类告警全部实际发出（emitted），且每条文案含当前值/阈值/时间/排查链接', async () => {
    expect(new Set(runResult.emitted)).toEqual(new Set(MONITOR_KEYS));

    const rows = await h.dataSource.query(
      "SELECT type, title, body, level, payload FROM notifications WHERE type LIKE 'ops.monitor.%' ORDER BY created_at",
    );
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row: { type: string }) => row.type))).toEqual(new Set(MONITOR_TYPES));

    for (const row of rows) {
      expect(String(row.body)).toContain('当前值：');
      expect(String(row.body)).toContain('阈值：');
      expect(String(row.body)).toContain('检查时间：');
      expect(String(row.body)).toContain('排查入口：https://auto.liangyijianye.cn/');
      expect(String(row.title)).toContain('[监控]');
      expect(row.payload.link).toContain('https://auto.liangyijianye.cn/');
    }
  });

  it('error 级告警额外落审计（ops.alert），便于事后追溯', async () => {
    const rows = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'ops.alert' AND created_at > now() - interval '3 minutes'",
    );
    const keys = rows.map((row: { payload: { key: string } }) => row.payload.key);
    expect(keys).toContain('queue_pending_age');
    expect(keys).toContain('login_failures');
  });

  it('阈值总览接口返回生效中的配置（后台可核对）', async () => {
    const response = await request(server()).get('/api/ops/monitor/thresholds').set(auth()).expect(200);
    expect(response.body.data.queueLengthThreshold).toBe(1);
    expect(response.body.data.pendingAgeSeconds).toBe(0);
    expect(response.body.data.diskUsedPercent).toBe(1);
    expect(response.body.data.aiQuotaPercent).toBe(1);
  });

  it('冷却生效：紧接着再跑一次不会重复告警（suppressed）', async () => {
    const response = await request(server()).post('/api/ops/monitor/run').set(auth()).expect(201);
    expect(response.body.data.emitted).toHaveLength(0);
    expect(response.body.data.suppressed.length).toBeGreaterThan(0);
  });
});
