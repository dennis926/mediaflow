/**
 * B0.7 计费/订阅/配额的**接口级**验证。
 *
 * 用"真实订阅 → 真实计划 → 真实超限"证明配额真的会拦住业务，而不是只写了张表：
 *   ① 发布次数配额：上限 1 → 第 1 个任务成功并记用量，第 2 个任务 403 且写审计 `quota.exceeded`；
 *   ② 配额查询接口：`GET /billing/quotas` 如实显示上限/已用/是否受限；
 *   ③ 成员数配额（瞬时口径）：上限 2 → 第 3 个成员 403；
 *   ④ 草稿账单：按计划价格生成（内部计划为 0），包含用量明细行，可重复调用但不会重复出账；
 *   ⑤ 套餐目录与支付渠道：目录可读，支付渠道明确"未接入"（防止以为能收款）。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E计费配额';
const TENANT = '11111111-1111-1111-1111-111111111111';

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：配额拦截 / 用量流水 / 草稿账单`, () => {
  let h: E2eHarness;
  let token = '';
  let workspaceId = '';
  let planId = '';
  let subscriptionId = '';
  const createdContentIds: string[] = [];
  const server = () => h.app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    const adminToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    workspaceId = await h.createWorkspace(`${PREFIX}-工作区-${Date.now()}`);
    // 关键：把令牌切到测试工作区——配额判定依据是"当前工作区"的有效订阅，用默认工作区的令牌
    // 会去查默认工作区的计划（那样既测不到，也会影响并行运行的其它套件）。
    token = await h.switchWorkspace(adminToken, workspaceId);

    // 一个"紧配额"的测试计划：发布 1 次、成员 2 人、存储 1MB、AI token 充足
    const plan = await h.dataSource.query(
      `INSERT INTO plans (id, tenant_id, created_at, updated_at, code, name, price_cents, currency, billing_period,
                          ai_token_quota, publish_quota, storage_quota_mb, member_quota, is_active, is_default, pricing_note)
       VALUES (gen_random_uuid(), $1, now(), now(), $2, '端到端紧配额计划', 0, 'CNY', 'month',
               1000000, 1, 1, 2, true, false, '测试用（非真实定价）')
       RETURNING id`,
      [TENANT, `e2e-limit-${Date.now()}`],
    );
    planId = plan[0].id as string;

    const subscription = await h.dataSource.query(
      `INSERT INTO subscriptions (id, tenant_id, workspace_id, created_at, updated_at, plan_id, status, started_at)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), $3, 'active', now()) RETURNING id`,
      [TENANT, workspaceId, planId],
    );
    subscriptionId = subscription[0].id as string;
  }, 120_000);

  afterAll(async () => {
    if (h) {
      if (createdContentIds.length > 0) {
        await h.dataSource.query('DELETE FROM publish_tasks WHERE content_id = ANY($1)', [createdContentIds]).catch(() => undefined);
      }
      await h.dataSource.query('DELETE FROM usage_records WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await h.dataSource.query('DELETE FROM quotas WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await h.dataSource.query('DELETE FROM invoices WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await h.dataSource.query('DELETE FROM subscriptions WHERE id = $1', [subscriptionId]).catch(() => undefined);
      await h.dataSource.query('DELETE FROM plans WHERE id = $1', [planId]).catch(() => undefined);
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  async function createContent(): Promise<string> {
    const response = await request(server())
      .post('/api/contents')
      .set(auth())
      .send({ title: `${PREFIX}-内容-${Date.now()}`, body: '配额测试正文', aiFlagType: 'none' })
      .expect(201);
    const id = response.body.data.id as string;
    createdContentIds.push(id);
    return id;
  }

  it('① 发布次数配额：第 1 次成功并记用量，第 2 次 403 + 审计', async () => {
    const contentId = await createContent();

    const first = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['wechat_mp'] })
      .expect(201);
    for (const task of first.body.data as Array<{ id: string }>) h.createdTaskIds.push(task.id);

    const usage = await h.dataSource.query(
      "SELECT count(*)::int AS n, COALESCE(SUM(quantity), 0)::numeric AS total FROM usage_records WHERE workspace_id = $1 AND kind = 'publish'",
      [workspaceId],
    );
    expect(Number(usage[0].n)).toBeGreaterThan(0);
    expect(Number(usage[0].total)).toBeGreaterThan(0);

    const counter = await h.dataSource.query(
      "SELECT used_value, limit_value FROM quotas WHERE workspace_id = $1 AND kind = 'publish'",
      [workspaceId],
    );
    expect(counter.length).toBe(1);
    expect(Number(counter[0].limit_value)).toBe(1);
    expect(Number(counter[0].used_value)).toBe(1);

    // 第二次换一个平台（避免撞"同内容同平台重复建单"的 409），应当被配额拦住
    const second = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['zhihu'] });
    expect(second.status).toBe(403);
    expect(String(second.body.message)).toContain('发布次数');
    expect(String(second.body.message)).toContain('上限 1');

    const audits = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'quota.exceeded' AND workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
      [workspaceId],
    );
    expect(audits.length).toBe(1);
    expect((audits[0].payload as { kind: string }).kind).toBe('publish');
  }, 120_000);

  it('② GET /billing/quotas：如实显示上限/已用/是否受限', async () => {
    const response = await request(server()).get('/api/billing/quotas').set(auth()).expect(200);
    const items = response.body.data as Array<{ kind: string; limit: number; used: number; unlimited: boolean; planCode: string }>;
    const publish = items.find((item) => item.kind === 'publish');
    expect(publish?.limit).toBe(1);
    expect(publish?.unlimited).toBe(false);
    expect(publish?.used).toBeGreaterThanOrEqual(1);
    const storage = items.find((item) => item.kind === 'upload_mb');
    expect(storage?.limit).toBe(1);
    expect(publish?.planCode).toMatch(/^e2e-limit-/);
  }, 120_000);

  it('③ 成员数配额（瞬时口径）：上限 2，第 3 个成员 403', async () => {
    const second = await h.createUser({ roleCodes: ['editor'], displayName: '端到端成员二' });
    await request(server())
      .put(`/api/workspaces/${workspaceId}/members`)
      .set(auth())
      .send({ userId: second.id, roleCodes: ['editor'] })
      .expect(200);

    const third = await h.createUser({ roleCodes: ['viewer'], displayName: '端到端成员三' });
    const blocked = await request(server())
      .put(`/api/workspaces/${workspaceId}/members`)
      .set(auth())
      .send({ userId: third.id, roleCodes: ['viewer'] });
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.message)).toContain('成员数');

    // 数据库层面也确认第 3 个成员没有被写进去
    const rows = await h.dataSource.query(
      'SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(Number(rows[0].n)).toBe(2);

    const status = await request(server()).get('/api/billing/quotas').set(auth()).expect(200);
    const member = (status.body.data as Array<{ kind: string; limit: number; used: number }>).find((item) => item.kind === 'member');
    expect(member?.limit).toBe(2);
    expect(member?.used).toBe(2);
    // 用量流水里也应有成员新增的记录（瞬时类只落流水）
    const usage = await h.dataSource.query(
      "SELECT count(*)::int AS n FROM usage_records WHERE workspace_id = $1 AND kind = 'member'",
      [workspaceId],
    );
    expect(Number(usage[0].n)).toBeGreaterThan(0);
  }, 120_000);

  it('④ 草稿账单：按计划价格生成、含用量明细行、重复调用不重复出账', async () => {
    // 指定"本月"才能看到本月刚产生的用量明细（不传参数时默认出上个月的账）
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const first = await request(server())
      .post(`/api/billing/invoices/draft?period=${period}`)
      .set(auth())
      .expect(201);
    const invoice = first.body.data as { id: string; number: string; status: string; amountCents: string; lines: Array<{ description: string }> };
    expect(invoice.status).toBe('draft');
    expect(Number(invoice.amountCents)).toBe(0); // 测试计划价格为 0（定价待 B2）
    expect(invoice.number).toMatch(/^INV-\d{6}-/);
    expect(invoice.lines.length).toBeGreaterThan(1); // 订阅费 + 用量明细

    const again = await request(server())
      .post(`/api/billing/invoices/draft?period=${period}`)
      .set(auth())
      .expect(201);
    expect((again.body.data as { number: string }).number).toBe(invoice.number);

    // 不传周期时默认只为"上一个自然月"出账（本月还没走完，账不该先出）
    const lastMonth = await request(server()).post('/api/billing/invoices/draft').set(auth()).expect(201);
    expect((lastMonth.body.data as { number: string }).number).not.toBe(invoice.number);

    const list = await request(server()).get('/api/billing/invoices').set(auth()).expect(200);
    expect((list.body.data as Array<{ number: string }>).filter((row) => row.number === invoice.number).length).toBe(1);

    // 本轮共生成两张草稿（本月 + 上月），每张都必须有审计，且至少一条对得上我们的账单号
    const audits = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'billing.invoice_draft_created' AND workspace_id = $1",
      [workspaceId],
    );
    expect((audits as Array<{ payload: { number: string; amountCents: number } }>).length).toBe(2);
    const numbers = (audits as Array<{ payload: { number: string } }>).map((row) => row.payload.number);
    expect(numbers).toContain(invoice.number);
  }, 120_000);

  it('⑤ 套餐目录可读；支付渠道明确未接入', async () => {
    const plans = await request(server()).get('/api/billing/plans').set(auth()).expect(200);
    const codes = (plans.body.data as Array<{ code: string }>).map((plan) => plan.code);
    expect(codes).toContain('internal');
    expect(codes.some((code) => code.startsWith('e2e-limit-'))).toBe(true);

    const provider = await request(server()).get('/api/billing/payment-provider').set(auth()).expect(200);
    expect((provider.body.data as { implemented: boolean }).implemented).toBe(false);
    expect(String((provider.body.data as { note: string }).note)).toContain('B2');
  }, 120_000);
});
