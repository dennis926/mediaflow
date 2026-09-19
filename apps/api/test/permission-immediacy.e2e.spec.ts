import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 类别 2：权限变更即时生效（审计 P1-2 / 任务 2 的回归防线）
 *
 * 全部使用**未过期**的旧令牌：停用 → 401、降权 → 403、移出工作区 → 404，
 * 且必须在下一个请求就生效（不依赖 30 秒缓存 TTL），缓存 key 要被主动删除。
 * 角色与令牌不一致时以数据库为准，并落 `auth.role_drift` 审计。
 */
const PREFIX = 'E2E权限即时';

describe.skipIf(!e2eCredentialsReady)('类别 2：权限变更即时生效', () => {
  let h: E2eHarness;
  let owner = '';
  /** 工作区 id 从库里读，不硬编码：线上库沿用的是历史种子 id，与代码里的常量可能不同。 */
  let workspaceId = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();
  const contents = (token: string) => request(server()).get('/api/contents').set(auth(token));
  const createContent = (token: string) =>
    request(server()).post('/api/contents').set(auth(token)).send({ title: `${PREFIX} 内容 ${Date.now()}`, body: '正文' });
  const cacheKeys = (userId: string) => h.redis.keys(`auth:user:${userId}:*`);

  beforeAll(async () => {
    h = await createHarness(PREFIX);
    owner = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const rows = await h.dataSource.query("SELECT id FROM workspaces WHERE slug = 'default' ORDER BY created_at LIMIT 1");
    workspaceId = rows[0].id as string;
    expect(workspaceId).toBeTruthy();
  }, 90_000);

  afterAll(async () => {
    await h?.cleanup();
    await h?.close();
  });

  it('1. 停用用户后未过期令牌立即 401，重新启用后恢复可用', async () => {
    const user = await h.createUser({ roleCodes: ['editor'] });
    await contents(user.token).expect(200);
    // 请求过后缓存里应有一份快照（TTL 30 秒）
    expect(await cacheKeys(user.id)).not.toHaveLength(0);

    await request(server())
      .patch(`/api/users/${user.id}/status`)
      .set(auth(owner))
      .send({ status: 'disabled' })
      .expect(200);

    // 主动失效：缓存 key 必须被删除，否则要等 30 秒
    expect(await cacheKeys(user.id)).toHaveLength(0);
    const blocked = await contents(user.token);
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe(40100);

    await request(server())
      .patch(`/api/users/${user.id}/status`)
      .set(auth(owner))
      .send({ status: 'active' })
      .expect(200);
    await contents(user.token).expect(200);
  });

  it('2. 降级后未过期令牌立即 403，且以数据库角色为准并落 auth.role_drift 审计', async () => {
    const user = await h.createUser({ roleCodes: ['editor'] });
    await createContent(user.token).expect(201); // editor 有 content.write

    await request(server())
      .patch(`/api/users/${user.id}/roles`)
      .set(auth(owner))
      .send({ roleCodes: ['viewer'] })
      .expect(200);

    const denied = await createContent(user.token);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe(40300);
    // 降级只收窄写权限，读权限仍在（不是把整个人踢掉）
    await contents(user.token).expect(200);

    const drift = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'auth.role_drift' AND resource_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id],
    );
    expect(drift.length).toBe(1);
    expect(drift[0].payload.tokenRoles).toContain('editor');
    expect(drift[0].payload.dbRoles).toContain('viewer');
  });

  it('3. 移出工作区成员后未过期令牌立即 404（用户仍存在）', async () => {
    const user = await h.createUser({ roleCodes: ['editor'] });
    await contents(user.token).expect(200);

    await request(server())
      .delete(`/api/workspaces/${workspaceId}/members/${user.id}`)
      .set(auth(owner))
      .expect(200);

    expect(await cacheKeys(user.id)).toHaveLength(0);
    const denied = await contents(user.token);
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe(40400);
    // 账号本身还在（只是不再是该工作区成员），与「账号被停用 401」区分开
    const rows = await h.dataSource.query('SELECT status FROM users WHERE id = $1', [user.id]);
    expect(rows[0]?.status).toBe('active');
  });
});
