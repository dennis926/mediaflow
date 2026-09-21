/**
 * GET /api/auth/capabilities（只读自己）。
 *
 * 前端按钮完全靠这份数据决定显隐，所以它必须与 CapabilityGuard 的判定一致，
 * 并且在"当前工作区已被软删"这个特殊状态下仍然可读（否则用户看不到"恢复"入口）。
 * 同时要证明：本接口的豁免是**只针对它自己**的——其他业务接口在软删态下依旧 404。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E能力点';


interface CapabilitiesView {
  workspaceId: string;
  role: string | null;
  roles: string[];
  capabilities: string[];
  workspaceStatus: string;
  isSuperAdmin: boolean;
}

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：GET /auth/capabilities`, () => {
  let h: E2eHarness;
  const server = () => h.app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const readCapabilities = async (token: string): Promise<CapabilitiesView> => {
    const response = await request(server()).get('/api/auth/capabilities').set(auth(token)).expect(200);
    return response.body.data as CapabilitiesView;
  };

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
  }, 120_000);

  afterAll(async () => {
    if (h && !(h as unknown as { closed?: boolean }).closed) {
      // 安全网：确认默认工作区仍是 active，再清理本次创建的数据
      const rows = await h.dataSource.query("SELECT status FROM workspaces WHERE slug = 'default' LIMIT 1");
      expect(rows[0]?.status).toBe('active');
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  it('1. 只读账号：拿不到删除/归档/恢复/导出，且只能看到自己的工作区', async () => {
    const viewer = await h.createUser({ roleCodes: ['viewer'], displayName: '端到端只读' });
    const view = await readCapabilities(viewer.token);

    expect(view.role).toBe('viewer');
    expect(view.roles).toEqual(['viewer']);
    for (const dangerous of ['workspace.delete', 'workspace.archive', 'workspace.restore', 'workspace.export', 'workspace.purge', 'content.write', 'settings.write']) {
      expect(view.capabilities, dangerous).not.toContain(dangerous);
    }
    // 只读账号仍应能读到自己所在的工作区标识（不是别人/全局的信息）
    const memberships = await h.dataSource.query('SELECT workspace_id FROM workspace_members WHERE user_id = $1', [viewer.id]);
    expect(memberships).toHaveLength(1);
    expect(view.workspaceId).toBe(memberships[0].workspace_id);
  }, 60_000);

  it('2. 所有者：拿到生命周期能力点与 content.review，且 role 为 owner', async () => {
    const ownerToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const view = await readCapabilities(ownerToken);

    expect(view.role).toBe('owner');
    expect(view.workspaceStatus).toBe('active');
    expect(view.capabilities).toEqual(
      expect.arrayContaining(['workspace.archive', 'workspace.delete', 'workspace.restore', 'workspace.export', 'workspace.purge']),
    );
    // 与只读账号的差别必须真实存在（否则前端按钮会误导用户）
    const viewer = await h.createUser({ roleCodes: ['viewer'], displayName: '端到端只读2' });
    const viewerView = await readCapabilities(viewer.token);
    expect(viewerView.capabilities.length).toBeLessThan(view.capabilities.length);
  }, 60_000);

  it('3. 工作区被软删后：owner 仍能读到能力点（含 workspace.restore），但其他业务接口依旧 404', async () => {
    const workspaceId = await h.createWorkspace(`${PREFIX}-软删-${Date.now()}`);
    const ownerToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const scoped = await h.switchWorkspace(ownerToken, workspaceId);

    // 软删前：状态 active、可读业务接口
    const before = await readCapabilities(scoped);
    expect(before.workspaceId).toBe(workspaceId);
    expect(before.workspaceStatus).toBe('active');

    const name = (await h.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [workspaceId]))[0].name as string;
    await request(server()).delete(`/api/workspaces/${workspaceId}`).set(auth(scoped)).send({ confirmName: name }).expect(200);

    // 软删后：能力点仍可读，且能看到"恢复"入口
    const after = await readCapabilities(scoped);
    expect(after.workspaceId).toBe(workspaceId);
    expect(after.workspaceStatus).toBe('soft_deleted');
    expect(after.capabilities).toContain('workspace.restore');
    expect(after.role).toBe('owner');

    // 豁免只针对本接口：同样的令牌访问业务接口必须 404（不暴露该工作区曾经存在）
    await request(server()).get('/api/contents').set(auth(scoped)).expect(404);

    // 恢复后再看：回到 active，恢复能力点仍在（用于再次软删）
    await request(server()).post(`/api/workspaces/${workspaceId}/restore`).set(auth(scoped)).expect(200);
    const restored = await readCapabilities(scoped);
    expect(restored.workspaceStatus).toBe('active');
    expect(restored.capabilities).toContain('workspace.restore');
  }, 90_000);

  it('4. 当前工作区被软删后：仍能列出自己的工作区并切走（否则界面无路可走）', async () => {
    const workspaceId = await h.createWorkspace(`${PREFIX}-逃生-${Date.now()}`);
    const ownerToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const scoped = await h.switchWorkspace(ownerToken, workspaceId);
    const name = (await h.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [workspaceId]))[0].name as string;
    await request(server()).delete(`/api/workspaces/${workspaceId}`).set(auth(scoped)).send({ confirmName: name }).expect(200);

    // 1) "我参与的工作区"仍可读（含其他可用工作区），前端才有地方点"切换"
    const list = await request(server()).get('/api/workspaces').set(auth(scoped)).expect(200);
    const items = (list.body.data ?? []) as Array<{ id: string }>;
    expect(items.some((item) => item.id !== workspaceId)).toBe(true);

    // 2) 豁免只给"逃生"接口：业务接口在软删态下依旧 404（不暴露该工作区曾存在）
    await request(server()).get('/api/contents').set(auth(scoped)).expect(404);

    // 3) 能切走，且新令牌能正常访问业务接口
    const other = items.find((item) => item.id !== workspaceId);
    const switched = await request(server())
      .post('/api/auth/switch-workspace')
      .set(auth(scoped))
      .send({ workspaceId: other?.id })
      .expect(201);
    const newToken = switched.body.data.accessToken as string;
    await request(server()).get('/api/contents').set(auth(newToken)).expect(200);
  }, 90_000);
});
