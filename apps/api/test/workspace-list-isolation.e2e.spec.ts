/**
 * GET /workspaces 的**信息泄露检查**。
 *
 * 背景：B0.4 为了让"删掉当前工作区"的用户还能切走，给 `GET /workspaces` 与
 * `POST /auth/switch-workspace` 开了状态闸门豁免（见 DESIGN-工作区管理UI.md §10.4）。
 * 豁免意味着"已软删的工作区"这条路径也能读这个接口 —— 必须证明它**只返回调用者自己参与的工作区**，
 * 不因为豁免而泄露别家工作区的名称/状态/成员。
 *
 * 四条断言：① 软删态下返回集合 == 该用户在 workspace_members 里的集合；
 *          ② 每个返回项都能在该用户的成员关系里找到（逐项比对，不是只看数量）；
 *          ③ 非成员在软删态下一律看不到该工作区；
 *          ④ 返回字段只有约定字段（不含成员、邮箱、统计等额外信息）。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E列表泄露';
// 注意保持字典序：与 Object.keys(...).sort() 比较时数组顺序有意义
const ALLOWED_FIELDS = ['id', 'isCurrent', 'name', 'roleCodes', 'slug', 'status'];

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：GET /workspaces 只返回"我参与的"`, () => {
  let h: E2eHarness;
  const server = () => h.app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const membershipsOf = async (userId: string): Promise<string[]> => {
    const rows = await h.dataSource.query('SELECT workspace_id FROM workspace_members WHERE user_id = $1', [userId]);
    return (rows as Array<{ workspace_id: string }>).map((row) => row.workspace_id).sort();
  };

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
  }, 120_000);

  afterAll(async () => {
    if (h) {
      const rows = await h.dataSource.query("SELECT status FROM workspaces WHERE slug = 'default' LIMIT 1");
      expect(rows[0]?.status).toBe('active');
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  it('软删态下：返回集合与本人的成员关系逐项一致，且字段不含额外信息', async () => {
    // 会员：被单独拉进一个新工作区（harness 的 createUser 会把新账号加进调用者当前工作区）
    const adminToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const member = await h.createUser({ roleCodes: ['editor'], displayName: '端到端会员' });
    const extraWorkspace = await h.createWorkspace(`${PREFIX}-会员-${Date.now()}`);
    await request(server())
      .put(`/api/workspaces/${extraWorkspace}/members`)
      .set(auth(adminToken))
      .send({ userId: member.id, roleCodes: ['editor'] })
      .expect(200);

    const scopedToken = await h.switchWorkspace(member.token, extraWorkspace);

    // 由**所有者**软删这个工作区（editor 没有删除权限，这是产品行为）；
    // 删除之后成员令牌仍指向它，正是要验证的豁免路径
    const name = (await h.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [extraWorkspace]))[0].name as string;
    await request(server()).delete(`/api/workspaces/${extraWorkspace}`).set(auth(adminToken)).send({ confirmName: name }).expect(200);

    const response = await request(server()).get('/api/workspaces').set(auth(scopedToken)).expect(200);
    const items = (response.body.data ?? []) as Array<Record<string, unknown>>;
    const membershipIds = await membershipsOf(member.id);

    // ① 集合一致（不多不少）
    expect(items.map((item) => item.id as string).sort()).toEqual(membershipIds);
    // ② 逐项比对：每一项都必须能在成员关系里找到
    for (const item of items) {
      expect(membershipIds).toContain(item.id as string);
    }
    // ③ 软删的工作区对"本人"可见（他自己参与，属于自有数据），状态如实暴露
    const softDeleted = items.find((item) => item.id === extraWorkspace);
    expect(softDeleted?.status).toBe('soft_deleted');
    // ④ 字段白名单：不夹带成员列表、邮箱、统计等
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(ALLOWED_FIELDS);
    }
  }, 90_000);

  it('非成员：无论工作区是 active 还是 soft_deleted，都不出现在他的列表里', async () => {
    const outsider = await h.createUser({ roleCodes: ['viewer'], displayName: '端到端外部人' });
    const otherWorkspace = await h.createWorkspace(`${PREFIX}-外部-${Date.now()}`);
    const ownerToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const name = (await h.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [otherWorkspace]))[0].name as string;

    // active 状态下外部人就看不到
    let list = await request(server()).get('/api/workspaces').set(auth(outsider.token)).expect(200);
    expect((list.body.data as Array<{ id: string }>).map((item) => item.id)).not.toContain(otherWorkspace);

    // 软删之后同样看不到（豁免路径不得泄露别家工作区）
    await request(server()).delete(`/api/workspaces/${otherWorkspace}`).set(auth(ownerToken)).send({ confirmName: name }).expect(200);
    list = await request(server()).get('/api/workspaces').set(auth(outsider.token)).expect(200);
    expect((list.body.data as Array<{ id: string }>).map((item) => item.id)).not.toContain(otherWorkspace);

    // 外部人的列表 == 他自己的成员关系（逐项）
    const membershipIds = await membershipsOf(outsider.id);
    expect((list.body.data as Array<{ id: string }>).map((item) => item.id).sort()).toEqual(membershipIds);
  }, 90_000);
});
