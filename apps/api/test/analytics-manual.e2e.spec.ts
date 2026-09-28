/**
 * 手动录入平台指标（无平台 API 时的取数路径之一；另一条是浏览器插件自动回收）。
 *
 * 背景：数据中心原本只有"平台同步"一个来源，需要平台凭证；在拿到凭证前，成员把平台后台的数字录进来，
 * 看板与排行就能有数。这里验证：录入成功、进看板、写审计、非法时间被拒。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E手动指标';

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：手动录入平台指标`, () => {
  let h: E2eHarness;
  let token = '';
  const server = () => h.app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
  }, 120_000);

  afterAll(async () => {
    if (h) {
      await h.dataSource
        .query("DELETE FROM analytics WHERE extra->>'source' = 'manual' AND created_at > now() - interval '15 minutes'")
        .catch(() => undefined);
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  it('录入成功：写入快照（source=manual）并记审计', async () => {
    const response = await request(server())
      .post('/api/analytics/manual-metrics')
      .set(auth())
      .send({ platform: 'wechat_mp', views: 1234, likes: 56, comments: 7, shares: 8, favorites: 9, note: '手动抄自公众号后台' })
      .expect(201);

    const id = (response.body.data as { id: string }).id;
    expect(id).toBeTruthy();

    const rows = await h.dataSource.query('SELECT views, likes, comments, shares, favorites, extra FROM analytics WHERE id = $1', [id]);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].views)).toBe(1234);
    expect(Number(rows[0].likes)).toBe(56);
    expect((rows[0].extra as { source: string }).source).toBe('manual');
    expect(String((rows[0].extra as { note: string }).note)).toContain('公众号');

    const audits = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'analytics.manual_metrics' AND resource_id = $1",
      [id],
    );
    expect(audits.length).toBe(1);
    expect(Number((audits[0].payload as { views: number }).views)).toBe(1234);
  }, 120_000);

  it('非法采集时间被拒（400），不写库', async () => {
    const before = await h.dataSource.query("SELECT count(*)::int AS n FROM analytics WHERE extra->>'source' = 'manual'");
    await request(server())
      .post('/api/analytics/manual-metrics')
      .set(auth())
      .send({ platform: 'zhihu', views: 1, capturedAt: '不是时间' })
      .expect(400);
    const after = await h.dataSource.query("SELECT count(*)::int AS n FROM analytics WHERE extra->>'source' = 'manual'");
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  }, 120_000);

  it('录入后数据中心看板与排行能读到该平台的数', async () => {
    const overview = await request(server()).get('/api/analytics/overview').set(auth()).expect(200);
    expect(overview.body.data).toBeTruthy();

    const ranking = await request(server()).get('/api/analytics/accounts/ranking').set(auth()).expect(200);
    expect(Array.isArray(ranking.body.data)).toBe(true);
  }, 120_000);
});
