import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * 类别 3：跨工作区隔离（多租户底座，也是将来 SaaS 化的前提）
 *
 * 每个工作区只能看到自己的内容、素材、知识库、成员与审计。
 * B 区令牌拿到 A 区的资源 id 也必须 404 —— 靠的是服务端按 workspace 过滤，而不是前端不显示。
 */
const PREFIX = 'E2E跨区';
/** 1x1 透明 PNG：用于真实走一遍上传链路（magic byte + 白名单校验）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(!e2eCredentialsReady)('类别 3：跨工作区隔离', () => {
  let h: E2eHarness;
  let owner = '';
  let tokenB = '';
  let workspaceA = '';
  let workspaceB = '';
  let contentA = '';
  let mediaA = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await createHarness(PREFIX);
    owner = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const rows = await h.dataSource.query("SELECT id FROM workspaces WHERE slug = 'default' ORDER BY created_at LIMIT 1");
    workspaceA = rows[0].id as string;

    workspaceB = await h.createWorkspace(`${PREFIX}-B-${Date.now()}`);
    const member = await h.createUser({ roleCodes: ['editor'] });
    await request(server())
      .put(`/api/workspaces/${workspaceB}/members`)
      .set(auth(owner))
      // 用 B 区管理员做隔离验证：连管理员也看不到别的工作区，才算真的隔离
      .send({ userId: member.id, roleCodes: ['admin'] })
      .expect(200);
    tokenB = await h.switchWorkspace(member.token, workspaceB);

    const decoded = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64url').toString('utf8')) as { workspaceId: string };
    expect(decoded.workspaceId).toBe(workspaceB);

    const created = await request(server())
      .post('/api/contents')
      .set(auth(owner))
      .send({ title: `${PREFIX} A区专属内容 ${Date.now()}`, body: 'A 区正文' })
      .expect(201);
    contentA = created.body.data.id as string;

    const upload = await request(server())
      .post('/api/media')
      .set(auth(owner))
      .field('groupName', 'E2E跨区')
      .attach('file', PNG, { filename: 'e2e-cross.png', contentType: 'image/png' })
      .expect(201);
    mediaA = upload.body.data.id as string;
  }, 120_000);

  afterAll(async () => {
    if (mediaA) {
      await request(server()).delete(`/api/media/${mediaA}`).set(auth(owner)).catch(() => undefined);
    }
    await h?.cleanup();
    await h?.close();
  });

  it('1. B 区令牌读 A 区内容 → 404', async () => {
    const response = await request(server()).get(`/api/contents/${contentA}`).set(auth(tokenB));
    expect(response.status).toBe(404);
  });

  it('2. B 区令牌改/删 A 区内容 → 404，且内容未被改动', async () => {
    const updated = await request(server()).put(`/api/contents/${contentA}`).set(auth(tokenB)).send({ body: '越权改写' });
    expect(updated.status).toBe(404);

    const removed = await request(server()).delete(`/api/contents/${contentA}`).set(auth(tokenB));
    expect(removed.status).toBe(404);

    const after = await request(server()).get(`/api/contents/${contentA}`).set(auth(owner)).expect(200);
    expect(after.body.data.body).toBe('A 区正文');
  });

  it('3. B 区令牌列内容 → 不含 A 区内容（列表按工作区过滤）', async () => {
    const list = await request(server()).get('/api/contents').set(auth(tokenB)).expect(200);
    const items = (list.body.data.items ?? list.body.data) as Array<{ id: string; title: string }>;
    expect(items.some((item) => item.id === contentA)).toBe(false);
    expect(items.some((item) => String(item.title).startsWith(PREFIX))).toBe(false);

    const listA = await request(server()).get('/api/contents').set(auth(owner)).expect(200);
    const itemsA = (listA.body.data.items ?? listA.body.data) as Array<{ id: string }>;
    expect(itemsA.some((item) => item.id === contentA)).toBe(true);
  });

  it('4. B 区知识库为空，A 区非空（知识库同样按工作区分区）', async () => {
    const knowledgeB = await request(server()).get('/api/knowledge').set(auth(tokenB)).expect(200);
    const listB = (knowledgeB.body.data.items ?? knowledgeB.body.data) as unknown[];
    expect(listB.length).toBe(0);

    const knowledgeA = await request(server()).get('/api/knowledge').set(auth(owner)).expect(200);
    const listA = (knowledgeA.body.data.items ?? knowledgeA.body.data) as unknown[];
    expect(listA.length).toBeGreaterThan(0);
  });

  it('5. B 区素材列表不含 A 区素材', async () => {
    const mediaB = await request(server()).get('/api/media').set(auth(tokenB)).expect(200);
    const items = (mediaB.body.data.items ?? mediaB.body.data) as Array<{ id: string }>;
    expect(items.some((item) => item.id === mediaA)).toBe(false);

    const mediaA2 = await request(server()).get('/api/media').set(auth(owner)).expect(200);
    const itemsA = (mediaA2.body.data.items ?? mediaA2.body.data) as Array<{ id: string }>;
    expect(itemsA.some((item) => item.id === mediaA)).toBe(true);
  });

  it('6. B 区审计列表只含 B 区记录，且不出现 A 区资源', async () => {
    const auditB = await request(server()).get('/api/audit-logs?pageSize=100').set(auth(tokenB)).expect(200);
    const items = (auditB.body.data.items ?? []) as Array<{ workspaceId: string; resourceId: string | null }>;
    expect(items.every((item) => item.workspaceId === workspaceB)).toBe(true);
    expect(items.some((item) => item.resourceId === contentA)).toBe(false);

    const auditA = await request(server()).get('/api/audit-logs?pageSize=100').set(auth(owner)).expect(200);
    const itemsA = (auditA.body.data.items ?? []) as Array<{ workspaceId: string }>;
    expect(itemsA.every((item) => item.workspaceId === workspaceA)).toBe(true);
  });

  it('7. B 区成员列表不含 A 区管理员', async () => {
    const usersB = await request(server()).get('/api/users').set(auth(tokenB)).expect(200);
    const items = (usersB.body.data.items ?? usersB.body.data) as Array<{ email: string }>;
    const emails = items.map((item) => item.email);
    expect(emails).not.toContain(process.env.E2E_ADMIN_EMAIL);
  });

  it('8. 反向隔离：A 区令牌读 B 区内容 → 404', async () => {
    const created = await request(server())
      .post('/api/contents')
      .set(auth(tokenB))
      .send({ title: `${PREFIX} B区专属内容 ${Date.now()}`, body: 'B 区正文' })
      .expect(201);
    const contentB = created.body.data.id as string;

    const response = await request(server()).get(`/api/contents/${contentB}`).set(auth(owner));
    expect(response.status).toBe(404);
  });
});
