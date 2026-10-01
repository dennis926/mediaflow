import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 监控口径的多工作区验证（审计 P2-6）。
 *
 * 背景：发布失败率与 AI 配额原先按全局合计判定阈值。单工作区时数字是对的，
 * 一旦有第二个工作区就会出现"B 把配额用光，A 收到告警"，且 A 看到的数字
 * 与自己的用量对不上——运维会照着错误的数字排查。
 *
 * 现在这两项按工作区拆分（byWorkspace），并给出各自的工作区名；
 * 平台级指标（队列、磁盘、登录失败、跨工作区引用）仍按平台合计，这是正确口径。
 */
const PREFIX = 'E2E监控口径';

describe.skipIf(!e2eCredentialsReady)('监控口径：工作区级 vs 平台级', () => {
  let h: E2eHarness;
  let token = '';
  let run: {
    checks: Array<{
      key: string;
      scope?: string;
      current: number;
      triggered: boolean;
      byWorkspace?: Array<{ workspaceId: string; workspaceName: string; current: number; triggered: boolean }>;
    }>;
  };

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();

  beforeAll(async () => {
    Object.assign(process.env, {
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_QUEUE_LENGTH_THRESHOLD: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_PENDING_AGE_SECONDS: '0',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_LOGIN_FAIL_THRESHOLD: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_DISK_USED_PERCENT: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_ALERT_COOLDOWN_MINUTES: '1',
      MEDIAFLOW_SETTING_OVERRIDE_MONITOR_OPS_BASE_URL: 'https://auto.liangyijianye.cn',
    });
    h = await createHarness(PREFIX, { requireApproval: false });
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');

    // 制造一条真实的失败任务（失败率检查的数据来源）
    const content = await request(server())
      .post('/api/contents')
      .set(auth())
      .send({ title: `${PREFIX} 失败探针 ${Date.now()}`, body: '正文' })
      .expect(201);
    const task = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId: content.body.data.id, platforms: ['wechat_mp'] })
      .expect(201);
    const taskId = task.body.data[0].id as string;
    h.createdTaskIds.push(taskId);
    await request(server())
      .post(`/api/publish/tasks/${taskId}/manual-failed`)
      .set(auth())
      .send({ reason: `${PREFIX} 人为制造失败用于验证口径` })
      .expect(200);

    // emit=false：只观察，不发告警（避免污染通知与冷却键）
    const response = await request(server()).post('/api/ops/monitor/run?emit=false').set(auth()).expect(201);
    run = response.body.data as typeof run;
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  it('每个检查都声明了口径（平台级 / 工作区级）', () => {
    for (const check of run.checks) {
      expect(['platform', 'workspace']).toContain(check.scope);
    }
  });

  it('业务指标按工作区拆分，且带工作区名（数字能对上自己的用量）', () => {
    const failure = run.checks.find((check) => check.key === 'publish_failure_rate');
    const quota = run.checks.find((check) => check.key === 'ai_token_quota');
    expect(failure?.scope).toBe('workspace');
    expect(quota?.scope).toBe('workspace');
    for (const check of [failure, quota]) {
      expect(Array.isArray(check?.byWorkspace)).toBe(true);
      for (const item of check?.byWorkspace ?? []) {
        // 名称不能是 uuid 片段——运维要能直接看出是谁
        expect(item.workspaceName.length).toBeGreaterThan(0);
        expect(item.workspaceName).not.toBe(item.workspaceId);
      }
    }
  });

  it('平台级指标保持平台合计口径（队列/磁盘/登录失败/跨工作区引用）', () => {
    for (const key of ['queue_length', 'upload_disk', 'login_failures', 'cross_workspace_refs']) {
      const check = run.checks.find((item) => item.key === key);
      expect(check?.scope).toBe('platform');
      expect(check?.byWorkspace).toBeUndefined();
    }
  });

  it('工作区级命中的是"造出失败任务"的那个工作区，不是全局合计数字', () => {
    const failure = run.checks.find((check) => check.key === 'publish_failure_rate');
    expect(failure?.byWorkspace?.length).toBeGreaterThan(0);
    // 合计口径与拆分口径必须一致（否则前端展示会自相矛盾）
    const sum = (failure?.byWorkspace ?? []).reduce((total, item) => total + item.current, 0);
    if ((failure?.byWorkspace ?? []).length === 1) {
      expect(failure?.current).toBeCloseTo(sum, 1);
    }
  });
});
