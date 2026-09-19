import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 类别 4：重复投递 / 并发认领（P2-4、P2-2）
 *
 * Redis Stream 消费组保证「一条消息只投递给一个消费者」，这是不重复发布的地基：
 * 两个 Worker 同时读、两个 Worker 同时认领陈旧消息，都不能出现同一任务被处理两次。
 * 另外覆盖：取消后的任务不得被 retry/requeue 复活；重复建单的当前行为（P2-2 已知问题）。
 */
const PREFIX = 'E2E并发认领';

describe.skipIf(!e2eCredentialsReady)('类别 4：重复投递 / 并发认领', () => {
  let h: E2eHarness;
  let token = '';
  let contentId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();

  beforeAll(async () => {
    // 陈旧消息认领的等待窗口设为最小值（5 秒），避免测试等 30 秒
    process.env.MEDIAFLOW_SETTING_OVERRIDE_PUBLISH_CLAIM_IDLE_MS = '5000';
    h = await createHarness(PREFIX, { requireApproval: false });
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    await h.queue.ensureGroup();
    const created = await request(server())
      .post('/api/contents')
      .set(auth())
      .send({ title: `${PREFIX} 内容 ${Date.now()}`, body: '正文' })
      .expect(201);
    contentId = created.body.data.id as string;
  }, 90_000);

  afterAll(async () => {
    await h?.cleanup();
    await h?.close();
  });

  it('1. 两个消费者并发读同一条流：消息不重复投递（交集为空）', async () => {
    const taskIds = Array.from({ length: 4 }, () => randomUUID());
    for (const taskId of taskIds) await h.queue.enqueue(taskId);

    const [first, second] = await Promise.all([h.queue.read('e2e-c1', 4, 300), h.queue.read('e2e-c2', 4, 300)]);
    const firstIds = first.map((entry) => entry.id);
    const secondIds = second.map((entry) => entry.id);

    // 关键性质：任何一条消息不会同时投递给两个消费者
    expect(firstIds.filter((id) => secondIds.includes(id))).toHaveLength(0);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);

    // 剩下的消息也要能被读到（不能丢）
    const rest = await h.queue.read('e2e-c1', 10, 300);
    const allDelivered = [...first, ...second, ...rest].map((entry) => entry.taskId);
    expect(new Set(allDelivered)).toEqual(new Set(taskIds));
    expect(allDelivered).toHaveLength(taskIds.length); // 每条恰好一次

    for (const entry of [...first, ...second, ...rest]) await h.queue.ack(entry.id);
  });

  it('2. 两个 Worker 并发认领陈旧消息：每条只归属一个 Worker', async () => {
    const taskIds = [randomUUID(), randomUUID()];
    for (const taskId of taskIds) await h.queue.enqueue(taskId);

    // 先投递给一个「已死的消费者」，制造未确认消息
    const delivered = await h.queue.read('e2e-dead-worker', 2, 300);
    expect(delivered).toHaveLength(2);

    // 等待超过 claimIdleMs（5 秒）后，两个 Worker 同时认领
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const [workerA, workerB] = await Promise.all([h.queue.claimStale('e2e-w1'), h.queue.claimStale('e2e-w2')]);
    const idsA = workerA.map((entry) => entry.id);
    const idsB = workerB.map((entry) => entry.id);

    expect(idsA.filter((id) => idsB.includes(id))).toHaveLength(0);
    expect(new Set([...workerA, ...workerB].map((entry) => entry.taskId))).toEqual(new Set(taskIds));

    for (const entry of [...workerA, ...workerB]) await h.queue.ack(entry.id);
  }, 30_000);

  it('3. 已取消的任务：retry 与 requeue 都必须拒绝（P2-4）', async () => {
    const created = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['wechat_mp'] })
      .expect(201);
    const taskId = created.body.data[0].id as string;
    h.createdTaskIds.push(taskId);

    await request(server()).delete(`/api/publish/tasks/${taskId}`).set(auth()).expect(200);

    const retry = await request(server()).post(`/api/publish/tasks/${taskId}/retry`).set(auth());
    expect(retry.status).toBe(400);
    expect(String(retry.body.message)).toContain('已取消的任务不能重试');

    const requeue = await request(server()).post(`/api/publish/tasks/${taskId}/requeue`).set(auth());
    expect(requeue.status).toBe(400);
    expect(String(requeue.body.message)).toContain('已取消的任务不能重排');

    // 取消后状态必须仍是 canceled，不能被上面两次调用改掉
    const after = await request(server()).get(`/api/publish/tasks/${taskId}`).set(auth()).expect(200);
    expect(after.body.data.status).toBe('canceled');

    // 重复取消也要拒绝（已是终态）
    const cancelAgain = await request(server()).delete(`/api/publish/tasks/${taskId}`).set(auth());
    expect(cancelAgain.status).toBe(400);
  });

  it('4. 同一内容同平台重复建单 → 第二次 409；取消后可再次建单（P2-2 已修）', async () => {
    const first = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['zhihu'] })
      .expect(201);
    const firstId = first.body.data[0].id as string;
    h.createdTaskIds.push(firstId);

    // 幂等闸门：同一内容同一平台已有未完成任务时不再建单
    const second = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['zhihu'] });
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain('已有未完成任务');

    const rows = await h.dataSource.query(
      "SELECT count(*)::int AS n FROM publish_tasks WHERE content_id = $1 AND platform = 'zhihu' AND status IN ('pending','scheduled','publishing')",
      [contentId],
    );
    expect(rows[0].n).toBe(1);

    // 取消后（不再活跃）可以重新排期
    await request(server()).delete(`/api/publish/tasks/${firstId}`).set(auth()).expect(200);
    const third = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['zhihu'] })
      .expect(201);
    h.createdTaskIds.push(third.body.data[0].id as string);
  });
});
