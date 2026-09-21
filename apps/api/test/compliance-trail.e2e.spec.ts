/**
 * B0.6 合规留痕的**接口级**验证。
 *
 * 四项都要"经过真实 HTTP + 真实数据库"证明：
 *   ① AI 标识系统化：内容有 `ai_generations` 记录却标成 `none` 时，审核通过前**强制回填**标识（或按理由豁免留痕）；
 *   ② 审核留痕：审核记录带 `operator_ip` / `operator_ua`（谁、从哪、用什么客户端放行）；
 *   ③ `GET /me/export`：用户能导出自己的数据（ZIP，含账号/内容/审核/审计/AI 调用）；
 *   ④ 合规删除：登记请求 → 软删 → `purge_after` 收紧到 30 天内 → 恢复则视为撤回（全部留痕）。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E合规留痕';
const TENANT = '11111111-1111-1111-1111-111111111111';
const UA = 'MediaFlow-E2E/1.0 (compliance-trail)';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：AI 标识 / 审核留痕 / 个人导出 / 合规删除`, () => {
  let h: E2eHarness;
  let ownerToken = '';
  let reviewerToken = '';
  const createdContentIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const server = () => h.app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** 最小行插入（照抄级联测试的做法，避免把 NOT NULL 列写死）。 */
  async function insertAiGeneration(contentId: string): Promise<void> {
    const columns: Array<{ column_name: string; data_type: string; column_default: string | null }> =
      await h.dataSource.query(
        `SELECT column_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ai_generations' AND is_nullable = 'NO'
          ORDER BY ordinal_position`,
      );
    const explicit: Record<string, string> = {
      tenant_id: `'${TENANT}'`,
      workspace_id: `'22222222-2222-2222-2222-222222222222'`,
      content_id: `'${contentId}'`,
      provider: `'deepseek'`,
      model: `'deepseek-v4-flash'`,
      task_type: `'generate'`,
      status: `'success'`,
    };
    const names: string[] = [];
    const values: string[] = [];
    for (const column of columns) {
      if (column.column_name in explicit) {
        names.push(`"${column.column_name}"`);
        values.push(explicit[column.column_name]);
        continue;
      }
      if (column.column_default) continue;
      names.push(`"${column.column_name}"`);
      if (column.data_type === 'uuid') values.push('gen_random_uuid()');
      else if (column.data_type.includes('timestamp')) values.push('now()');
      else if (['integer', 'bigint', 'numeric'].includes(column.data_type)) values.push('0');
      else if (column.data_type === 'jsonb') values.push(`'{}'::jsonb`);
      else values.push(`'合规测试'`);
    }
    // 显式指定的可空列（如 content_id）不在 NOT NULL 列清单里，必须单独补上
    for (const [column, value] of Object.entries(explicit)) {
      if (!names.includes(`"${column}"`)) {
        names.push(`"${column}"`);
        values.push(value);
      }
    }
    await h.dataSource.query(`INSERT INTO ai_generations (${names.join(', ')}) VALUES (${values.join(', ')})`);
  }

  async function createContent(title: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await request(server())
      .post('/api/contents')
      .set(auth(ownerToken))
      .send({ title, body: '合规测试正文', aiFlagType: 'none', ...overrides })
      .expect(201);
    const id = response.body.data.id as string;
    createdContentIds.push(id);
    return id;
  }

  async function approveAs(contentId: string): Promise<number> {
    const submitted = await request(server())
      .post('/api/reviews/submit')
      .set(auth(ownerToken))
      .set('User-Agent', UA)
      .send({ contentId })
      .expect(201);
    const reviewId = submitted.body.data.id as string;
    const decided = await request(server())
      .put(`/api/reviews/${reviewId}`)
      .set(auth(reviewerToken))
      .set('User-Agent', UA)
      .send({ decision: 'approved', checklist: { aiDisclosure: true } });
    return decided.status;
  }

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    ownerToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const reviewer = await h.createUser({ roleCodes: ['reviewer'], displayName: '端到端审核员' });
    reviewerToken = reviewer.token;
  }, 120_000);

  afterAll(async () => {
    if (h) {
      if (createdContentIds.length > 0) {
        await h.dataSource.query('DELETE FROM ai_generations WHERE content_id = ANY($1)', [createdContentIds]).catch(() => undefined);
        await h.dataSource.query('DELETE FROM content_reviews WHERE content_id = ANY($1)', [createdContentIds]).catch(() => undefined);
      }
      for (const workspaceId of createdWorkspaceIds) {
        await h.dataSource.query('DELETE FROM data_deletion_requests WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      }
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  it('① 有 AI 生成记录却标成 none：审核通过前被强制回填标识并留痕', async () => {
    const contentId = await createContent(`合规-强制回填-${Date.now()}`);
    await insertAiGeneration(contentId);
    const evidenceCheck = await h.dataSource.query('SELECT count(*)::int AS n FROM ai_generations WHERE content_id = $1', [contentId]);
    expect(Number(evidenceCheck[0].n), 'AI 生成记录（证据行）必须已落库，否则这条用例是空转').toBeGreaterThan(0);

    const status = await approveAs(contentId);
    expect(status).toBe(200);

    const rows = await h.dataSource.query(
      'SELECT ai_flag_type, ai_generated, body FROM contents WHERE id = $1',
      [contentId],
    );
    expect(rows[0].ai_flag_type).toBe('assisted');
    expect(rows[0].ai_generated).toBe(true);
    expect(String(rows[0].body)).toContain('AI'); // 显式标识文案已并入正文

    const audits = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'content.ai_flag.backfilled' AND resource_id = $1",
      [contentId],
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(Number((audits[0].payload as { evidence: number }).evidence)).toBeGreaterThan(0);
  }, 120_000);

  it('①b 填了豁免理由：保留 none，但理由与证据条数必须留痕', async () => {
    const contentId = await createContent(`合规-豁免留痕-${Date.now()}`, {
      aiFlagExemptReason: '仅用 AI 做错别字检查，未生成内容',
    });
    // 通过更新接口再写一次，确保理由落库（创建时也可传）
    await request(server())
      .put(`/api/contents/${contentId}`)
      .set(auth(ownerToken))
      .send({ aiFlagType: 'none', aiFlagExemptReason: '仅用 AI 做错别字检查，未生成内容' })
      .expect(200);
    await insertAiGeneration(contentId);

    const reason = await h.dataSource.query('SELECT ai_flag_exempt_reason FROM contents WHERE id = $1', [contentId]);
    expect(reason[0].ai_flag_exempt_reason).toContain('错别字');

    expect(await approveAs(contentId)).toBe(200);

    const rows = await h.dataSource.query('SELECT ai_flag_type FROM contents WHERE id = $1', [contentId]);
    expect(rows[0].ai_flag_type).toBe('none'); // 有理由 → 不强制回填

    const audits = await h.dataSource.query(
      "SELECT payload FROM audit_logs WHERE action = 'content.ai_flag.exempted' AND resource_id = $1",
      [contentId],
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(String((audits[0].payload as { reason: string }).reason)).toContain('错别字');
    expect(Number((audits[0].payload as { evidence: number }).evidence)).toBeGreaterThan(0);
  }, 120_000);

  it('② 审核留痕：审核记录带 operator_ip 与 operator_ua', async () => {
    const contentId = await createContent(`合规-审核留痕-${Date.now()}`);
    expect(await approveAs(contentId)).toBe(200);

    const rows = await h.dataSource.query(
      'SELECT operator_ip, operator_ua, status FROM content_reviews WHERE content_id = $1',
      [contentId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].operator_ip).toBeTruthy();
    expect(rows[0].operator_ua).toBe(UA);
    expect(rows[0].status).toBe('approved');
  }, 120_000);

  it('③ GET /me/export：导出自己的数据（ZIP，含账号/内容/审核/审计/AI 调用），并留痕', async () => {
    const response = await request(server())
      .get('/api/me/export')
      .set(auth(ownerToken))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const body = response.body as Buffer;
    expect(body.subarray(0, 4)).toEqual(ZIP_MAGIC);
    const text = body.toString('latin1');
    for (const entry of ['me.json', 'data/my-contents.jsonl', 'data/my-reviews.jsonl', 'data/my-audit.jsonl', 'data/my-ai-calls.jsonl', 'README.txt']) {
      expect(text, `导出包缺少 ${entry}`).toContain(entry);
    }
    // 不包含凭据类内容（安全断言）
    expect(text).not.toContain('enc:v1:');

    const audits = await h.dataSource.query(
      "SELECT action FROM audit_logs WHERE action IN ('me.export.requested','me.export.downloaded') AND actor_id = (SELECT id FROM users WHERE email = $1)",
      [process.env.E2E_ADMIN_EMAIL ?? ''],
    );
    const actions = (audits as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toContain('me.export.requested');
    expect(actions).toContain('me.export.downloaded');
  }, 120_000);

  it('④ 合规删除：登记请求 → 软删 → purge_after 收紧到 30 天内 → 恢复即撤回（全程留痕）', async () => {
    const workspaceId = await h.createWorkspace(`${PREFIX}-删除请求-${Date.now()}`);
    createdWorkspaceIds.push(workspaceId);
    const name = (await h.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [workspaceId]))[0].name as string;

    const created = await request(server())
      .post(`/api/workspaces/${workspaceId}/deletion-request`)
      .set(auth(ownerToken))
      .send({ confirmName: name, reason: '客户行使删除权（合规请求）' })
      .expect(200);
    const view = created.body.data.request as { status: string; dueAt: string; daysUntilDue: number };
    expect(view.status).toBe('pending');
    expect(view.daysUntilDue).toBeGreaterThan(28);
    expect(view.daysUntilDue).toBeLessThanOrEqual(30);

    // 工作区已软删，且 purge_after 不晚于承诺期限（且不超过 30 天）
    const rows = await h.dataSource.query('SELECT status, purge_after FROM workspaces WHERE id = $1', [workspaceId]);
    expect(rows[0].status).toBe('soft_deleted');
    const purgeAfter = new Date(rows[0].purge_after as string).getTime();
    const thirtyDays = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(purgeAfter).toBeLessThanOrEqual(thirtyDays + 60_000);

    // 台账与审计
    const requests = await h.dataSource.query(
      'SELECT status, reason, due_at FROM data_deletion_requests WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(requests.length).toBe(1);
    expect(requests[0].status).toBe('pending');
    expect(String(requests[0].reason)).toContain('删除权');
    const audits = await h.dataSource.query(
      "SELECT action FROM audit_logs WHERE action = 'compliance.deletion_requested' AND resource_id = $1",
      [workspaceId],
    );
    expect(audits.length).toBe(1);

    // 状态接口可查
    const status = await request(server()).get(`/api/workspaces/${workspaceId}/deletion-request`).set(auth(ownerToken)).expect(200);
    expect((status.body.data as { status: string }).status).toBe('pending');

    // 恢复 = 撤回请求（必须留痕）
    await request(server()).post(`/api/workspaces/${workspaceId}/restore`).set(auth(ownerToken)).expect(200);
    const after = await h.dataSource.query('SELECT status FROM data_deletion_requests WHERE workspace_id = $1', [workspaceId]);
    expect(after[0].status).toBe('cancelled');
    const cancelAudits = await h.dataSource.query(
      "SELECT action FROM audit_logs WHERE action = 'compliance.deletion_cancelled' AND resource_id = $1",
      [workspaceId],
    );
    expect(cancelAudits.length).toBe(1);
  }, 120_000);
});
