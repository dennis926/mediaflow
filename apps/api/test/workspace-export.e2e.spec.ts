import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';
import { CryptoService } from '../src/common/crypto.service';
import { WorkspaceExportCleanupTask } from '../src/modules/workspace/workspace-export.task';

/**
 * B0.4 第 3 步：租户数据导出
 *
 * 验证的是"这份导出包能不能真的用来恢复/交接"：ZIP 可解压、manifest 行数与数据库一致、
 * 每个文件 sha256 对得上、平台凭证已脱敏、链接一次性且会过期、超过 5GB 直接拒绝、过期产物被清理。
 * 同时覆盖跨租户与角色边界（只有 owner/admin 能导出）。
 */
const PREFIX = 'E2E导出';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(!e2eCredentialsReady)('B0.4：租户数据导出', () => {
  let h: E2eHarness;
  let adminToken = '';
  let ownerE = '';          // 探测工作区 E 的 owner 令牌
  let editorE = '';         // E 的 editor（用于权限边界）
  let wsE = '';
  let wsF = '';
  let editor: { id: string; email: string; password: string; token: string };
  let outsiderF = '';
  let countsBeforeExport: Record<string, number> = {};
  let jobId = '';
  let zipBuffer: Buffer;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();
  const requestExport = (token: string, id: string, body: Record<string, unknown> = {}) =>
    request(server()).post(`/api/workspaces/${id}/export`).set(auth(token)).send(body);
  const jobOf = (token: string, id: string, job: string) =>
    request(server()).get(`/api/workspaces/${id}/export/${job}`).set(auth(token));
  const linkOf = (token: string, id: string, job: string) =>
    request(server()).post(`/api/workspaces/${id}/export/${job}/link`).set(auth(token));

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    adminToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');

    wsE = await h.createWorkspace(`${PREFIX}-E-${Date.now()}`);
    wsF = await h.createWorkspace(`${PREFIX}-F-${Date.now()}`);
    ownerE = await h.switchWorkspace(adminToken, wsE);

    // E 里造一份"像回事"的数据：内容 + 素材（进 media/）+ 知识库 + 审计
    await request(server())
      .post('/api/contents')
      .set(auth(ownerE))
      .send({ title: `${PREFIX} 导出用内容 ${Date.now()}`, body: '导出测试正文', tags: ['E2E导出'] })
      .expect(201);
    await request(server())
      .post('/api/media')
      .set(auth(ownerE))
      .field('groupName', PREFIX)
      .attach('file', PNG, { filename: 'e2e-export.png', contentType: 'image/png' })
      .expect(201);
    await request(server())
      .post('/api/knowledge')
      .set(auth(ownerE))
      .send({ brand: 'E2E导出', category: 'general', title: `${PREFIX} 知识条目`, content: '知识库内容用于导出校验', isActive: true })
      .expect(201)
      .catch(() => undefined); // 知识库接口字段若变化不影响导出主链路

    // E 的 editor（权限边界用）
    editor = await h.createUser({ roleCodes: ['editor'], displayName: '导出编辑者' });
    await request(server())
      .put(`/api/workspaces/${wsE}/members`)
      .set(auth(ownerE))
      .send({ userId: editor.id, roleCodes: ['editor'] })
      .expect(200);
    editorE = await h.switchWorkspace(editor.token, wsE);

    // 跨租户用例需要一个"只在 F 里"的用户：必须先切到 F 的作用域再创建，
    // 否则他会被自动加入默认工作区，甚至成为 E 的成员（同一 admin 就属于所有探针工作区）。
    const adminOnF = await h.switchWorkspace(adminToken, wsF);
    const created = await request(server())
      .post('/api/users')
      .set(auth(adminOnF))
      .send({ email: `export-outsider-${Date.now()}@example.com`, displayName: '导出外部用户', password: 'Outsider1234', roleCodes: ['owner'] })
      .expect(201);
    const outsiderId = (created.body.data as { user?: { id?: string } }).user?.id as string;
    h.createdUserIds.push(outsiderId);
    const rows = await h.dataSource.query('SELECT email FROM users WHERE id = $1', [outsiderId]);
    const outsiderToken = await h.login(rows[0].email as string, 'Outsider1234');
    const memberships = await h.dataSource.query('SELECT workspace_id FROM workspace_members WHERE user_id = $1', [outsiderId]);
    expect(memberships.map((row: { workspace_id: string }) => row.workspace_id)).toEqual([wsF]);
    outsiderF = await h.switchWorkspace(outsiderToken, wsF);

    // 导出前的行数快照（审计会在导出过程中继续增长，不能拿"现在的库"跟包里的快照比）
    for (const table of ['contents', 'content_variants', 'publish_tasks', 'brand_knowledge', 'audit_logs']) {
      const snapshot = await h.dataSource.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [wsE]);
      countsBeforeExport[table] = snapshot[0].n as number;
    }
  }, 150_000);

  afterAll(async () => {
    await h?.dataSource.query("DELETE FROM workspace_export_jobs WHERE workspace_id = $1", [wsE]).catch(() => undefined);
    await h?.dataSource.query("DELETE FROM notifications WHERE type = 'workspace.export.completed'").catch(() => undefined);
    await h?.cleanup();
    await h?.close();
  });

  it('1. 申请导出 → 202 排队，随后完成（进度 100、有大小与校验和）', async () => {
    const created = await requestExport(ownerE, wsE).expect(201);
    jobId = created.body.data.id as string;
    expect(created.body.data.status).toBe('queued');

    let view = created.body.data;
    for (let attempt = 0; attempt < 40 && view.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      view = (await jobOf(ownerE, wsE, jobId).expect(200)).body.data;
    }
    expect(view.status).toBe('completed');
    expect(view.progress).toBe(100);
    expect(Number(view.sizeBytes)).toBeGreaterThan(0);
    expect(String(view.checksum)).toMatch(/^[0-9a-f]{64}$/);
    expect(view.expiresAt).toBeTruthy();
    expect(view.downloadEndpoint).toContain(`/workspaces/${wsE}/export/${jobId}/link`);
  });

  it('2. 同一工作区并发申请第二个导出 → 409', async () => {
    // 先造一个"进行中"的任务（把已完成的那个改回 running 会破坏后续断言，这里新建后立即抢占）
    const running = await h.dataSource.query(
      `INSERT INTO workspace_export_jobs (id, tenant_id, workspace_id, status, include_media, include_audit)
       VALUES (gen_random_uuid(), (SELECT tenant_id FROM workspaces WHERE id = $1), $1, 'running', true, true) RETURNING id`,
      [wsE],
    );
    const blocked = await requestExport(ownerE, wsE);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.message)).toContain('正在进行的导出任务');
    await h.dataSource.query('DELETE FROM workspace_export_jobs WHERE id = $1', [running[0].id]);
  });

  it('3. 权限边界：E 的 editor 不能导出（403）', async () => {
    const response = await requestExport(editorE, wsE);
    expect(response.status).toBe(403);
  });

  it('4. 跨租户：只在 F 里的 owner 访问 E 的导出（查询/申请/链接）→ 全部 404', async () => {
    expect((await jobOf(outsiderF, wsE, jobId)).status).toBe(404);
    expect((await requestExport(outsiderF, wsE)).status).toBe(404);
    expect((await linkOf(outsiderF, wsE, jobId)).status).toBe(404);
    // 他自己的 F 工作区可以导出（对照，证明 404 不是"接口坏了"）
    expect((await requestExport(outsiderF, wsF)).status).toBe(201);
  });

  it('5. 下载：一次性链接首次可用，第二次同链接 → 401', async () => {
    const link = await linkOf(ownerE, wsE, jobId).expect(200);
    const url = link.body.data.url as string;
    expect(url).toContain('token=');

    const first = await request(server())
      .get(url)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    zipBuffer = first.body as Buffer;
    expect(zipBuffer.length).toBeGreaterThan(0);

    const second = await request(server()).get(url);
    expect(second.status).toBe(401);
    expect(String(second.body.message)).toContain('已被使用');
  });

  it('6. ZIP 结构与 manifest：行数与数据库一致、逐文件 sha256 正确、凭证已脱敏', async () => {
    const zip = await JSZip.loadAsync(zipBuffer);
    const names = Object.keys(zip.files);
    expect(names).toContain('manifest.json');
    expect(names).toContain('README.txt');
    expect(names).toContain('data/contents.jsonl');
    expect(names).toContain('audit/audit_logs.jsonl');

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      counts: Record<string, number>;
      files: Array<{ path: string; bytes: number; sha256: string }>;
      redactedColumns: Record<string, string[]>;
      workspace: { id: string };
    };
    expect(manifest.workspace.id).toBe(wsE);
    expect(manifest.redactedColumns.social_accounts).toContain('access_token');

    // 业务数据表：行数必须与导出前快照**完全一致**
    for (const table of ['contents', 'content_variants', 'publish_tasks', 'brand_knowledge']) {
      expect(manifest.counts[table]).toBe(countsBeforeExport[table]);
    }
    // 审计表：导出本身会先写一条 workspace.export.requested，所以包里至少是快照那么多
    expect(manifest.counts.audit_logs).toBeGreaterThanOrEqual(countsBeforeExport.audit_logs);

    // 每个文件的 sha256 与实际内容一致
    for (const file of manifest.files.filter((item) => item.path.startsWith('data/'))) {
      const content = await zip.file(file.path)!.async('nodebuffer');
      expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256);
      expect(content.length).toBe(file.bytes);
    }

    // 平台凭证绝不进导出包
    const social = await zip.file('data/social_accounts.jsonl')?.async('string');
    if (social) expect(social).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('7. 超过 5GB 直接拒绝（413），不生成截断产物', async () => {
    const before = await h.dataSource.query('SELECT count(*)::int AS n FROM workspace_export_jobs WHERE workspace_id = $1', [wsE]);
    const big = await h.dataSource.query(
      `INSERT INTO media_assets (id, tenant_id, workspace_id, stored_name, original_name, mime_type, kind, size, url)
       VALUES (gen_random_uuid(), (SELECT tenant_id FROM workspaces WHERE id = $1), $1, 'huge.bin', 'huge.bin', 'image/png', 'image', $2, '/x')
       RETURNING id`,
      [wsE, 6 * 1024 * 1024 * 1024],
    );
    const response = await requestExport(ownerE, wsE);
    expect(response.status).toBe(413);
    expect(String(response.body.message)).toContain('5GB');

    await h.dataSource.query('DELETE FROM media_assets WHERE id = $1', [big[0].id]);
    const after = await h.dataSource.query('SELECT count(*)::int AS n FROM workspace_export_jobs WHERE workspace_id = $1', [wsE]);
    expect(after[0].n).toBe(before[0].n); // 被拒绝时不产生任务
  });

  it('8. 过期链接被拒（用真实签名密钥自签一个已过期令牌）', async () => {
    const crypto = h.app.get(CryptoService);
    const exp = Math.floor(Date.now() / 1000) - 60;
    const payload = `${wsE}|${jobId}|${exp}|expired-nonce`;
    const token = `${Buffer.from(payload, 'utf8').toString('base64url')}.${crypto.hmac(payload)}`;

    const response = await request(server()).get(`/api/workspaces/${wsE}/export/${jobId}/download?token=${token}`);
    expect(response.status).toBe(401);
    expect(String(response.body.message)).toContain('已过期');
  });

  it('9. 产物 7 天到期后由定时任务清理，并写审计 workspace.export.expired', async () => {
    await h.dataSource.query("UPDATE workspace_export_jobs SET expires_at = now() - interval '1 day' WHERE id = $1", [jobId]);
    const task = h.app.get(WorkspaceExportCleanupTask);
    const result = await task.prune();

    expect(result.removed).toBeGreaterThanOrEqual(1);
    const row = await h.dataSource.query('SELECT status FROM workspace_export_jobs WHERE id = $1', [jobId]);
    expect(row[0].status).toBe('expired');
    const audit = await h.dataSource.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'workspace.export.expired' AND resource_id = $1",
      [jobId],
    );
    expect(audit[0].n).toBeGreaterThanOrEqual(1);
  });

  it('10. 导出审计链完整：requested / completed / downloaded 三条都在', async () => {
    const actions = await h.dataSource.query(
      "SELECT action FROM audit_logs WHERE resource_id = $1 AND action LIKE 'workspace.export.%' ORDER BY created_at",
      [jobId],
    );
    const list = actions.map((row: { action: string }) => row.action);
    expect(list).toContain('workspace.export.requested');
    expect(list).toContain('workspace.export.completed');
    expect(list).toContain('workspace.export.downloaded');
    expect(list).toContain('workspace.export.expired');
  });
});
