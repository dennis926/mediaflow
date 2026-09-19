import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

/**
 * B0.2 / B0.3：数据库级完整性（P2-10 外键 + P2-2 唯一索引兜底）
 *
 * 这三件事只有数据库层面才能证明：
 *  1. 约束是否存在、删除规则对不对（CASCADE vs SET NULL）；
 *  2. 删内容时"版本历史跟着删、AI 流水保留但断开引用"是否真的发生；
 *  3. 并发下重复排期是否被唯一索引挡住（服务端校验之外的第二道闸门）。
 */
const PREFIX = 'E2E数据库完整性';

describe.skipIf(!e2eCredentialsReady)('B0.2/B0.3：外键与唯一索引', () => {
  let h: E2eHarness;
  let token = '';
  let workspaceId = '';
  let tenantId = '';
  let probeGenerationId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => h.app.getHttpServer();

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    token = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    const scope = await h.dataSource.query("SELECT id, tenant_id FROM workspaces WHERE slug = 'default' ORDER BY created_at LIMIT 1");
    workspaceId = scope[0].id as string;
    tenantId = scope[0].tenant_id as string;
  }, 90_000);

  afterAll(async () => {
    if (probeGenerationId) {
      await h?.dataSource.query('DELETE FROM ai_generations WHERE id = $1', [probeGenerationId]).catch(() => undefined);
    }
    await h?.cleanup();
    await h?.close();
  });

  it('1. 两个外键与部分唯一索引按预期存在，删除规则正确', async () => {
    const constraints = await h.dataSource.query(`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conname IN ('FK_content_revisions_content', 'FK_ai_generations_content')
    `);
    const byName = new Map(constraints.map((row: { conname: string; confdeltype: string }) => [row.conname, row.confdeltype]));
    // 'c' = CASCADE（版本历史跟随内容删除），'n' = SET NULL（AI 流水保留、断开引用）
    expect(byName.get('FK_content_revisions_content')).toBe('c');
    expect(byName.get('FK_ai_generations_content')).toBe('n');

    const indexes = await h.dataSource.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'UQ_publish_tasks_active_content_platform'",
    );
    expect(indexes).toHaveLength(1);
    expect(String(indexes[0].indexdef)).toContain('UNIQUE');
    expect(String(indexes[0].indexdef)).toContain("status");
  });

  it('2. 删除内容：变体与版本历史级联删除，AI 流水保留但 content_id 置空', async () => {
    const created = await request(server())
      .post('/api/contents')
      .set(auth())
      .send({ title: `${PREFIX} 级联验证 ${Date.now()}`, body: '正文' })
      .expect(201);
    const contentId = created.body.data.id as string;

    // 直接写入三类关联数据，确定性地验证数据库行为（不依赖业务路径是否创建这些行）
    await h.dataSource.query(
      `INSERT INTO content_variants (id, tenant_id, workspace_id, created_at, updated_at, content_id, platform, title, body, tags, media_urls, status, ai_flag_type, extra)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), $3, 'wechat_mp', '变体', '正文', '[]'::jsonb, '[]'::jsonb, 'draft', 'none', '{}'::jsonb)`,
      [tenantId, workspaceId, contentId],
    );
    await h.dataSource.query(
      `INSERT INTO content_revisions (id, tenant_id, workspace_id, created_at, updated_at, content_id, version, title, body, tags, media_urls, ai_flag_type, status)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), $3, 1, '版本', '正文', '[]'::jsonb, '[]'::jsonb, 'none', 'draft')`,
      [tenantId, workspaceId, contentId],
    );
    const generation = await h.dataSource.query(
      `INSERT INTO ai_generations (id, tenant_id, workspace_id, created_at, updated_at, provider, model, task_type, status, prompt, content_id, tokens_input)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), 'mock', 'mock-model', 'e2e-schema', 'success', '探针', $3, 10)
       RETURNING id`,
      [tenantId, workspaceId, contentId],
    );
    probeGenerationId = generation[0].id as string;

    const before = await h.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM content_variants WHERE content_id = $1) AS variants,
         (SELECT count(*)::int FROM content_revisions WHERE content_id = $1) AS revisions,
         (SELECT count(*)::int FROM ai_generations WHERE id = $2) AS generations`,
      [contentId, probeGenerationId],
    );
    expect(before[0]).toEqual({ variants: 1, revisions: 1, generations: 1 });

    // 硬删除内容（模拟合规删除 / 工作区硬删时的行为）
    await h.dataSource.query('DELETE FROM contents WHERE id = $1', [contentId]);

    const after = await h.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM content_variants WHERE content_id = $1) AS variants,
         (SELECT count(*)::int FROM content_revisions WHERE content_id = $1) AS revisions,
         (SELECT content_id FROM ai_generations WHERE id = $2) AS generation_content_id`,
      [contentId, probeGenerationId],
    );
    expect(after[0].variants).toBe(0);
    expect(after[0].revisions).toBe(0);
    expect(after[0].generation_content_id).toBeNull();
  });

  it('3. 数据库兜底：同一内容同一平台插入第二条未完成任务被唯一索引拒绝', async () => {
    const created = await request(server())
      .post('/api/contents')
      .set(auth())
      .send({ title: `${PREFIX} 并发兜底 ${Date.now()}`, body: '正文' })
      .expect(201);
    const contentId = created.body.data.id as string;

    const first = await request(server())
      .post('/api/publish/tasks')
      .set(auth())
      .send({ contentId, platforms: ['zhihu'] })
      .expect(201);
    h.createdTaskIds.push(first.body.data[0].id as string);

    // 绕过服务端校验，直接插第二条活跃任务：唯一索引必须拦住
    let code: string | undefined;
    try {
      await h.dataSource.query(
        `INSERT INTO publish_tasks (id, tenant_id, workspace_id, created_at, updated_at, content_id, platform, publish_mode, status, attempts, max_attempts, extra)
         VALUES (gen_random_uuid(), $1, $2, now(), now(), $3, 'zhihu', 'manual', 'pending', 0, 3, '{}'::jsonb)`,
        [tenantId, workspaceId, contentId],
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('23505');

    // 非活跃状态（已取消/已发布）不受索引约束：可以并存，便于历史追溯
    await h.dataSource.query(
      `INSERT INTO publish_tasks (id, tenant_id, workspace_id, created_at, updated_at, content_id, platform, publish_mode, status, attempts, max_attempts, extra)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), $3, 'zhihu', 'manual', 'canceled', 0, 3, '{}'::jsonb),
              (gen_random_uuid(), $1, $2, now(), now(), $3, 'zhihu', 'manual', 'published', 0, 3, '{}'::jsonb)`,
      [tenantId, workspaceId, contentId],
    );
    const rows = await h.dataSource.query(
      'SELECT count(*)::int AS n FROM publish_tasks WHERE content_id = $1',
      [contentId],
    );
    expect(rows[0].n).toBe(3);
    void randomUUID;
  });
});
