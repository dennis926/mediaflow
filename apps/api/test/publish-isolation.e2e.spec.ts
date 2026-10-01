import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 发布任务的跨工作区隔离（审计 P0-1 回归）。
 *
 * 背景：`publish.service.ts` 的 get/retry/cancel/requeue 曾经只用 `{ id }` 查库，
 * 少写 workspaceId 过滤，导致任意工作区的管理员可以读取、重试、**取消**别的工作区的发布任务
 * （取消是破坏性的：会打断对方正在排期的发布链路）。已实证复现，这里把它钉死。
 *
 * 修复后：跨区一律 404（与"任务不存在"同形，不暴露该任务存在），且目标任务状态不被改动。
 * 同时验证反向（A 区令牌打 B 区任务）与同区正常路径不受影响。
 */
const PREFIX = 'E2E发布隔离';

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：发布任务跨工作区隔离`, () => {
  let h: E2eHarness;
  let owner = '';
  let tokenB = '';
  let workspaceB = '';
  let taskA = '';
  let contentA = '';

  const server = () => h.app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function taskStatus(id: string): Promise<string> {
    const rows = await h.dataSource.query('SELECT status FROM publish_tasks WHERE id = $1', [id]);
    return rows[0]?.status as string;
  }

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    owner = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');

    // A 区（默认工作区）：建内容 + 一个真实发布任务
    const created = await request(server())
      .post('/api/contents')
      .set(auth(owner))
      .send({ title: `${PREFIX} A区内容 ${Date.now()}`, body: 'A 区正文', aiFlagType: 'none' })
      .expect(201);
    contentA = created.body.data.id as string;

    const task = await request(server())
      .post('/api/publish/tasks')
      .set(auth(owner))
      .send({ contentId: contentA, platforms: ['zhihu'] })
      .expect(201);
    taskA = task.body.data[0].id as string;
    h.createdTaskIds.push(taskA);

    // B 区：管理员令牌
    workspaceB = await h.createWorkspace(`${PREFIX}-B-${Date.now()}`);
    const member = await h.createUser({ roleCodes: ['editor'] });
    await request(server())
      .put(`/api/workspaces/${workspaceB}/members`)
      .set(auth(owner))
      .send({ userId: member.id, roleCodes: ['admin'] })
      .expect(200);
    tokenB = await h.switchWorkspace(member.token, workspaceB);
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
    await h?.close();
  });

  it('① B 区管理员读 A 区发布任务 → 404（不是 200）', async () => {
    const response = await request(server()).get(`/api/publish/tasks/${taskA}`).set(auth(tokenB));
    expect(response.status).toBe(404);

    // 反向：A 区令牌读 B 区任务（用 B 区自己建的任务）同样 404
    const contentB = await request(server())
      .post('/api/contents')
      .set(auth(tokenB))
      .send({ title: `${PREFIX} B区内容 ${Date.now()}`, body: 'B 区正文', aiFlagType: 'none' })
      .expect(201);
    const taskB = await request(server())
      .post('/api/publish/tasks')
      .set(auth(tokenB))
      .send({ contentId: contentB.body.data.id, platforms: ['zhihu'] })
      .expect(201);
    h.createdTaskIds.push(taskB.body.data[0].id as string);

    const reverse = await request(server()).get(`/api/publish/tasks/${taskB.body.data[0].id}`).set(auth(owner));
    expect(reverse.status).toBe(404);
  }, 120_000);

  it('② B 区管理员重试 A 区任务 → 404，且 A 区任务未被改动', async () => {
    const before = await taskStatus(taskA);
    const response = await request(server()).post(`/api/publish/tasks/${taskA}/retry`).set(auth(tokenB));
    expect(response.status).toBe(404);
    expect(await taskStatus(taskA)).toBe(before);
  }, 120_000);

  it('③ B 区管理员取消 A 区任务 → 404，且 A 区任务未被取消（破坏性用例）', async () => {
    const response = await request(server()).delete(`/api/publish/tasks/${taskA}`).set(auth(tokenB));
    expect(response.status).toBe(404);
    // 关键断言：状态不能变成 canceled
    expect(await taskStatus(taskA)).not.toBe('canceled');
  }, 120_000);

  it('④ B 区管理员重排 A 区任务 → 404', async () => {
    const response = await request(server()).post(`/api/publish/tasks/${taskA}/requeue`).set(auth(tokenB));
    expect(response.status).toBe(404);
  }, 120_000);

  it('⑤ B 区管理员批量取消里混入 A 区任务 → 只影响本区，A 区任务保持原状', async () => {
    const before = await taskStatus(taskA);
    const response = await request(server())
      .post('/api/publish/tasks/batch')
      .set(auth(tokenB))
      .send({ ids: [taskA], action: 'cancel' });
    // 批量接口逐条执行并返回失败明细：越权那条必须失败
    expect([200, 201]).toContain(response.status);
    const body = response.body.data as { affected: number; failed: Array<{ id: string; reason: string }> };
    expect(body.affected).toBe(0);
    expect(body.failed.some((item) => item.id === taskA)).toBe(true);
    expect(await taskStatus(taskA)).toBe(before);
  }, 120_000);

  it('⑥ 同区正常路径不受影响：A 区自己读/取消自己的任务', async () => {
    const detail = await request(server()).get(`/api/publish/tasks/${taskA}`).set(auth(owner)).expect(200);
    expect(detail.body.data.id).toBe(taskA);

    const canceled = await request(server()).delete(`/api/publish/tasks/${taskA}`).set(auth(owner)).expect(200);
    expect((canceled.body.data as { status: string }).status).toBe('canceled');
  }, 120_000);
});
