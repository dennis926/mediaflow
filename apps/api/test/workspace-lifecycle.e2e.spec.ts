import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * B0.4 第 2 步：工作区生命周期（归档 / 取消归档 / 软删 / 恢复）
 *
 * 三条设计要点在这里被真实验证：
 *  1. 权限按**目标工作区**判定 —— 别的租户的 owner 不能操作你的工作区（404 不泄露存在性）；
 *  2. 生命周期接口**豁免状态闸门** —— 用户把当前工作区软删后，仍能调 restore 自救；
 *  3. 归档 = 只读（读 200 / 写 403），软删 = 404，两者都在缓存失效后**下一个请求**生效。
 * 另外验证 M8：工作区被删除后，用户行必须保留（users.workspace_id 置空）。
 */
const PREFIX = 'E2E生命周期';

describe.skipIf(!e2eCredentialsReady)('B0.4：工作区生命周期', () => {
  let h: E2eHarness;
  let adminToken = '';
  let ownerC = '';        // 创建者令牌，作用域 = 探测工作区 C（他是 C 的 owner）
  let editorC = '';       // 编辑者令牌，作用域 = C（验证"归档只读"）
  let outsiderD = '';     // 外部用户令牌，作用域 = 探测工作区 D（验证跨租户越权）
  let wsC = '';
  let wsD = '';
  let defaultWorkspaceId = '';
  let editor: { id: string; email: string; password: string; token: string };
  let outsider: { id: string; email: string; password: string; token: string };
  let m8User: { id: string; email: string; password: string; token: string };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();
  const contents = (token: string) => request(server()).get('/api/contents').set(auth(token));
  const createContent = (token: string) =>
    request(server()).post('/api/contents').set(auth(token)).send({ title: `${PREFIX} 内容 ${Date.now()}`, body: '正文' });
  const archive = (token: string, id: string) => request(server()).post(`/api/workspaces/${id}/archive`).set(auth(token));
  const unarchive = (token: string, id: string) => request(server()).post(`/api/workspaces/${id}/unarchive`).set(auth(token));
  const softDelete = (token: string, id: string, confirmName: string) =>
    request(server()).delete(`/api/workspaces/${id}`).set(auth(token)).send({ confirmName });
  const restore = (token: string, id: string) => request(server()).post(`/api/workspaces/${id}/restore`).set(auth(token));
  const statusOf = async (id: string) =>
    (await h.dataSource.query('SELECT status, purge_after, deleted_at, archived_at FROM workspaces WHERE id = $1', [id]))[0];

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    adminToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const rows = await h.dataSource.query("SELECT id FROM workspaces WHERE slug = 'default' ORDER BY created_at LIMIT 1");
    defaultWorkspaceId = rows[0].id as string;

    wsC = await h.createWorkspace(`${PREFIX}-C-${Date.now()}`);
    wsD = await h.createWorkspace(`${PREFIX}-D-${Date.now()}`);
    ownerC = await h.switchWorkspace(adminToken, wsC);

    // 编辑者：默认工作区成员 + C 的 editor（用来验证"归档只读"）
    editor = await h.createUser({ roleCodes: ['editor'], displayName: '生命周期编辑者' });
    await request(server())
      .put(`/api/workspaces/${wsC}/members`)
      .set(auth(ownerC))
      .send({ userId: editor.id, roleCodes: ['editor'] })
      .expect(200);
    editorC = await h.switchWorkspace(editor.token, wsC);

    // 外部用户：**只在 D 里**是 owner（用来验证跨租户越权）。
    // 注意：创建用户时会把他加入"调用者当前所在的工作区"，所以必须先在 D 的作用域下创建，
    // 否则他会同时成为默认工作区的 owner —— 那样"跨租户"用例就会真的删掉默认工作区（已发生过一次）。
    const adminOnD = await h.switchWorkspace(adminToken, wsD);
    const outsiderCreated = await request(server())
      .post('/api/users')
      .set(auth(adminOnD))
      .send({
        email: `outsider-${Date.now()}@example.com`,
        displayName: '外部工作区所有者',
        password: 'Outsider1234',
        roleCodes: ['owner'],
      })
      .expect(201);
    const outsiderPayload = outsiderCreated.body.data as { user?: { id?: string } };
    const outsiderId = outsiderPayload.user?.id as string;
    h.createdUserIds.push(outsiderId);
    const outsiderRow = await h.dataSource.query('SELECT email FROM users WHERE id = $1', [outsiderId]);
    outsider = {
      id: outsiderId,
      email: outsiderRow[0].email as string,
      password: 'Outsider1234',
      token: await h.login(outsiderRow[0].email as string, 'Outsider1234'),
    };
    const outsiderMemberships = await h.dataSource.query(
      'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
      [outsiderId],
    );
    // 自检：他必须只属于 D，否则跨租户用例不成立
    expect(outsiderMemberships.map((row: { workspace_id: string }) => row.workspace_id)).toEqual([wsD]);
    outsiderD = await h.switchWorkspace(outsider.token, wsD);

    // M8 专用用户：把它的"默认工作区"设为 C（在 C 的作用域下创建），且只属于 C
    const created = await request(server())
      .post('/api/users')
      .set(auth(ownerC))
      .send({
        email: `m8-${Date.now()}@example.com`,
        displayName: 'M8 用户',
        password: 'M8Pass1234',
        roleCodes: ['editor'],
      })
      .expect(201);
    const payload = created.body.data as { user?: { id?: string } };
    const id = payload.user?.id as string;
    h.createdUserIds.push(id);
    m8User = { id, email: `m8-${Date.now()}@example.com`, password: 'M8Pass1234', token: '' };
    const row = await h.dataSource.query('SELECT email, workspace_id FROM users WHERE id = $1', [id]);
    m8User.email = row[0].email as string;
    m8User.token = await h.login(m8User.email, m8User.password);
  }, 150_000);

  afterAll(async () => {
    /**
     * 安全网：默认工作区是整套测试（以及其他一切）赖以运行的基础，绝不能被这些用例改动。
     * 若发现它不处于 active，说明有用例越界了 —— 立刻修回并在日志里留痕（不是掩盖：断言在下面）。
     */
    const rows = await h?.dataSource.query("SELECT status FROM workspaces WHERE slug = 'default'") ?? [];
    if (rows[0] && rows[0].status !== 'active') {
      // eslint-disable-next-line no-console
      console.error(`[E2E][安全网] 默认工作区被改动为 ${rows[0].status}，已自动修复`);
      await h.dataSource.query(
        "UPDATE workspaces SET status = 'active', archived_at = NULL, deleted_at = NULL, purge_after = NULL WHERE slug = 'default'",
      );
    }
    await h?.cleanup();
    await h?.close();
  });

  // ---------- 跨租户越权（补充 3 / 用例 15-18） ----------
  it('跨租户：外部工作区的 owner 对自己的工作区可操作，但对 C 的 4 个生命周期接口一律 404（不泄露存在性）', async () => {
    expect((await archive(outsiderD, wsC)).status).toBe(404);
    expect((await unarchive(outsiderD, wsC)).status).toBe(404);
    expect((await softDelete(outsiderD, wsC, 'whatever')).status).toBe(404);
    expect((await restore(outsiderD, wsC)).status).toBe(404);
    // 自己的 D 工作区：允许（对照，证明 404 不是"接口坏了"）
    expect((await archive(outsiderD, wsD)).status).toBe(200);
    expect((await unarchive(outsiderD, wsD)).status).toBe(200);
  });

  it('跨租户：外部 owner 也不能删除默认工作区', async () => {
    expect((await softDelete(outsiderD, defaultWorkspaceId, '默认工作区')).status).toBe(404);
  });

  it('探针工作区状态未被越权调用改变；默认工作区必须仍是 active（金丝雀）', async () => {
    expect((await statusOf(wsC)).status).toBe('active');
    const canary = await h.dataSource.query("SELECT status FROM workspaces WHERE slug = 'default'");
    expect(canary[0].status).toBe('active');
  });

  // ---------- 归档 = 只读 ----------
  it('归档：owner 可归档，返回状态与时间；审计 workspace.archive', async () => {
    const response = await archive(ownerC, wsC).expect(200);
    expect(response.body.data.status).toBe('archived');
    expect(response.body.data.archivedAt).toBeTruthy();

    const audit = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'workspace.archive' AND resource_id = $1 ORDER BY created_at DESC LIMIT 1",
      [wsC],
    );
    expect(audit.length).toBe(1);
    expect(audit[0].payload.previousStatus).toBe('active');
  });

  it('归档态：读放行（200），写操作 403 且提示取消归档', async () => {
    await contents(editorC).expect(200);

    const blocked = await createContent(editorC);
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.message)).toContain('已归档');
  });

  it('重复归档 → 409；取消归档后可正常写入', async () => {
    expect((await archive(ownerC, wsC)).status).toBe(409);

    const back = await unarchive(ownerC, wsC).expect(200);
    expect(back.body.data.status).toBe('active');
    expect(back.body.data.archivedAt).toBeNull();
    await createContent(editorC).expect(201);
  });

  // ---------- 软删前置校验 ----------
  it('软删前校验：名称不匹配 → 400', async () => {
    const response = await softDelete(ownerC, wsC, '名字写错了');
    expect(response.status).toBe(400);
    expect(String(response.body.message)).toContain('名称不匹配');
    expect((await statusOf(wsC)).status).toBe('active');
  });

  it('软删前校验：有未完成的发布任务 → 409', async () => {
    const content = await createContent(ownerC).expect(201);
    const task = await request(server())
      .post('/api/publish/tasks')
      .set(auth(ownerC))
      .send({ contentId: content.body.data.id, platforms: ['wechat_mp'] })
      .expect(201);
    h.createdTaskIds.push(task.body.data[0].id as string);

    const blocked = await softDelete(ownerC, wsC, (await statusOf(wsC)) && (await h.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [wsC]))[0].name);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.message)).toContain('未完成的发布任务');

    // 取消任务后即可软删
    await request(server()).delete(`/api/publish/tasks/${task.body.data[0].id}`).set(auth(ownerC)).expect(200);
  });

  // ---------- 软删 = 404 + 缓存失效 ----------
  it('软删：写入保留期与到期时间（默认 30 天）', async () => {
    const name = (await h.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [wsC]))[0].name as string;
    const response = await softDelete(ownerC, wsC, name).expect(200);
    expect(response.body.data.status).toBe('soft_deleted');
    expect(response.body.data.purgeAfter).toBeTruthy();
    expect(response.body.data.daysUntilPurge).toBe(30);
  });

  it('软删后：成员的下一个请求就是 404（缓存已主动失效）', async () => {
    expect(await h.redis.keys(`auth:user:${editor.id}:${wsC}`)).toHaveLength(0);
    expect((await contents(editorC)).status).toBe(404);
    expect((await createContent(editorC)).status).toBe(404);
  });

  // ---------- 恢复（含状态闸门豁免） ----------
  it('关键：当前工作区被软删后，其 owner 仍能调用 restore 自救（生命周期接口豁免状态闸门）', async () => {
    const response = await restore(ownerC, wsC).expect(200);
    expect(response.body.data.status).toBe('active');
    expect(response.body.data.deletedAt).toBeNull();
    expect(response.body.data.purgeAfter).toBeNull();
  });

  it('恢复后工作区立即可用（成员写入成功）', async () => {
    await contents(editorC).expect(200);
    await createContent(editorC).expect(201);
  });

  it('对未软删的工作区调 restore → 409', async () => {
    const response = await restore(ownerC, wsC);
    expect(response.status).toBe(409);
  });

  it('超过保留期后 restore → 410（明确不可恢复）', async () => {
    await h.dataSource.query(
      "UPDATE workspaces SET status = 'soft_deleted', deleted_at = now() - interval '31 days', purge_after = now() - interval '1 day' WHERE id = $1",
      [wsC],
    );
    const response = await restore(ownerC, wsC);
    expect(response.status).toBe(410);
    expect(String(response.body.message)).toContain('不可恢复');

    // 复位，避免影响后续用例
    await h.dataSource.query("UPDATE workspaces SET status = 'active', deleted_at = NULL, purge_after = NULL WHERE id = $1", [wsC]);
  });

  it('状态查询接口：owner 可读，包含倒计时字段', async () => {
    const response = await request(server()).get(`/api/workspaces/${wsC}/status`).set(auth(ownerC)).expect(200);
    expect(response.body.data.status).toBe('active');
    expect(response.body.data).toHaveProperty('daysUntilPurge', null);
  });

  // ---------- M8：删掉工作区，用户必须存活 ----------
  it('M8：删除工作区后，用户行保留、default workspace 置空、仍能登录（or 给出明确提示）', async () => {
    const before = await h.dataSource.query('SELECT workspace_id FROM users WHERE id = $1', [m8User.id]);
    expect(before[0].workspace_id).toBe(wsC);

    // 模拟永久清除的最后一步：删掉工作区行（成员关系由清理流程另行处理）
    await h.dataSource.query('DELETE FROM workspaces WHERE id = $1', [wsC]);
    await h.dataSource.query('DELETE FROM workspace_members WHERE workspace_id = $1', [wsC]);

    const after = await h.dataSource.query('SELECT workspace_id FROM users WHERE id = $1', [m8User.id]);
    expect(after).toHaveLength(1);          // 用户行没有被连带删除
    expect(after[0].workspace_id).toBeNull(); // 归属置空（SET NULL），而不是删人

    // 该用户已不属于任何可用工作区 → 登录被明确拒绝（403），而不是发出一个没有工作区的令牌
    const login = await request(server())
      .post('/api/auth/login')
      .send({ email: m8User.email, password: m8User.password });
    expect(login.status).toBe(403);
    expect(String(login.body.message)).toContain('工作区');
  });
});
