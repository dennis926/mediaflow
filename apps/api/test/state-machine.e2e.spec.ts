import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 类别 1：状态机越权（审计 P1-1 / 任务 3 的回归防线）
 *
 * 内容状态只能由服务端推进：创建固定 draft、更新不碰状态、发布必须「最新一轮审核通过且通过后未被修改」。
 * 这些用例全部走真实 HTTP 接口与真实数据库，不用 mock —— 直接改库伪造状态也必须被闸门拦住。
 */
const PREFIX = 'E2E状态机';

describe.skipIf(!e2eCredentialsReady)('类别 1：状态机越权', () => {
  let h: E2eHarness;
  let owner = '';
  let reviewer: { id: string; email: string; password: string; token: string };
  let contentId = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();
  const getStatus = async (id: string): Promise<string> => {
    const response = await request(server()).get(`/api/contents/${id}`).set(auth(owner)).expect(200);
    return response.body.data.status as string;
  };
  const dbStatus = async (id: string): Promise<string> => {
    const rows = await h.dataSource.query('SELECT status FROM contents WHERE id = $1', [id]);
    return rows[0]?.status as string;
  };
  const publishAttempt = (id: string) =>
    request(server()).post('/api/publish/tasks').set(auth(owner)).send({ contentId: id, platforms: ['wechat_mp'] });
  const submitReview = (id: string) => request(server()).post('/api/reviews/submit').set(auth(owner)).send({ contentId: id });
  const latestReviewId = async (id: string): Promise<string> => {
    const rows = await h.dataSource.query(
      'SELECT id FROM content_reviews WHERE content_id = $1 ORDER BY round DESC LIMIT 1',
      [id],
    );
    return rows[0]?.id as string;
  };
  const decide = (reviewId: string, decision: string, comments = '端到端测试结论') =>
    request(server()).put(`/api/reviews/${reviewId}`).set(auth(reviewer.token)).send({ decision, comments });

  beforeAll(async () => {
    h = await createHarness(PREFIX);
    owner = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    reviewer = await h.createUser({ roleCodes: ['reviewer'], displayName: '端到端审核人' });
  }, 90_000);

  afterAll(async () => {
    await h?.cleanup();
    await h?.close();
  });

  it('1. 创建内容时携带 status=approved 不会落地为 approved', async () => {
    const response = await request(server())
      .post('/api/contents')
      .set(auth(owner))
      .send({ title: `${PREFIX} 越权创建 ${Date.now()}`, body: '正文', status: 'approved' });

    // 白名单会丢弃 status（201 且为 draft），若改为拒绝必须显式 400，二者都可接受，但绝不能是 approved。
    expect([201, 400]).toContain(response.status);
    if (response.status === 400) {
      expect(response.body.code).toBe(40000);
      return;
    }
    contentId = response.body.data.id as string;
    expect(response.body.data.status).toBe('draft');
    expect(await dbStatus(contentId)).toBe('draft');
  });

  it('2. 更新内容时携带 status=approved 不改变状态', async () => {
    expect(contentId).toBeTruthy();
    await request(server())
      .put(`/api/contents/${contentId}`)
      .set(auth(owner))
      .send({ title: `${PREFIX} 越权更新 ${Date.now()}`, body: '更新后的正文', status: 'approved' })
      .expect(200);

    expect(await getStatus(contentId)).toBe('draft');
    expect(await dbStatus(contentId)).toBe('draft');
  });

  it('3. 未提审直接发布 → 400', async () => {
    const response = await publishAttempt(contentId);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(40000);
  });

  it('4. 提审被拒后发布 → 400', async () => {
    await submitReview(contentId).expect(201);
    const reviewId = await latestReviewId(contentId);
    await decide(reviewId, 'rejected', '测试：驳回').expect(200);

    const response = await publishAttempt(contentId);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(40000);
  });

  it('5. 提审通过后发布 → 201', async () => {
    await submitReview(contentId).expect(201);
    const reviewId = await latestReviewId(contentId);
    // 自己不能审自己提交的内容：用 owner 令牌审应当被拒绝
    const selfReview = await request(server())
      .put(`/api/reviews/${reviewId}`)
      .set(auth(owner))
      .send({ decision: 'approved', comments: '测试：自审' });
    expect(selfReview.status).toBeGreaterThanOrEqual(400);

    await decide(reviewId, 'approved', '测试：通过').expect(200);
    expect(await getStatus(contentId)).toBe('approved');

    const response = await publishAttempt(contentId);
    expect(response.status).toBe(201);
    const tasks = response.body.data as Array<{ id: string }>;
    expect(tasks.length).toBe(1);
    h.createdTaskIds.push(...tasks.map((task) => task.id));
  });

  it('6. 审核通过后再改正文 → 状态退回 draft 且发布 400', async () => {
    // 闸门用「审批时记录的内容版本」比较，并留 1 秒容差；这里跨过容差窗口再改，模拟真实编辑。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await request(server())
      .put(`/api/contents/${contentId}`)
      .set(auth(owner))
      .send({ body: '审核通过后又被改动的正文' })
      .expect(200);

    expect(await getStatus(contentId)).toBe('draft');
    const response = await publishAttempt(contentId);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(40000);
  });

  it('7. 归档后发布 → 400', async () => {
    await submitReview(contentId).expect(201);
    await decide(await latestReviewId(contentId), 'approved', '测试：再次通过').expect(200);

    await request(server()).patch(`/api/contents/${contentId}/archive`).set(auth(owner)).send({ archived: true }).expect(200);
    expect(await getStatus(contentId)).toBe('archived');

    const response = await publishAttempt(contentId);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(40000);
  });

  it('附加：审核过程中的状态流转写入了 content.status_change 审计', async () => {
    const rows = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'content.status_change' AND resource_id = $1 ORDER BY created_at",
      [contentId],
    );
    const transitions = rows.map((row: { payload: { to?: string } }) => row.payload?.to);
    expect(transitions).toContain('reviewing');
    expect(transitions).toContain('approved');
    expect(transitions).toContain('rejected');
    expect(transitions).toContain('archived');
  });
});
