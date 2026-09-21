/**
 * B0.4 第 5 步：外键补全后的**级联实测**。
 *
 * 这套测试不看"约束是否存在"，而是真的造数据、真的删工作区行，然后逐表核对结果：
 *
 *   ① 15 张工作区私有/结构性表：父行一删，子行全部消失（CASCADE）；
 *   ② `workspace_export_jobs`：行**保留**、`workspace_id` 被置空（SET NULL，第 1 步设计意图）；
 *   ③ B 类账本表（`audit_logs` / `ai_generations` / `workspace_purge_batches`）：**刻意不加外键**，
 *      父行删掉后它们的行必须还在（合规留痕 + 成本账本，删了就丢证据）；
 *   ④ 删除工作区不会波及其它工作区。
 *
 * 造数据用"最小行"策略：从 information_schema 读出 NOT NULL 列，按类型填合法值，
 * 只在必须引用父行的地方（contents / platforms）显式指定。这样将来加 NOT NULL 列也不会把测试写死。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E级联';
const TENANT = '11111111-1111-1111-1111-111111111111';

/** CASCADE：随工作区一起消失 */
const CASCADE_TABLES = [
  'contents',
  'content_variants',
  'content_revisions',
  'content_reviews',
  'publish_tasks',
  'analytics',
  'track_events',
  'media_assets',
  'social_accounts',
  'brand_knowledge',
  'content_templates',
  'platforms',
  'workspace_members',
  'notifications',
];

/** 刻意不加外键：必须留下 */
const LEDGER_TABLES = ['audit_logs', 'ai_generations', 'workspace_purge_batches'];

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：删工作区时的级联行为`, () => {
  let h: E2eHarness;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let contentId = '';
  let platformId = '';
  let exportJobId = '';

  /** 按 information_schema 生成"最小可插入行"，避免 NULL 违约。 */
  async function insertMinimal(table: string, explicit: Record<string, string>): Promise<string> {
    const columns: Array<{ column_name: string; data_type: string; column_default: string | null }> =
      await h.dataSource.query(
        `SELECT column_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO'
          ORDER BY ordinal_position`,
        [table],
      );
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
      const type = column.data_type;
      if (type === 'uuid') values.push(`gen_random_uuid()`);
      else if (type.includes('timestamp')) values.push('now()');
      else if (['integer', 'bigint', 'smallint', 'numeric'].includes(type)) values.push('0');
      else if (type === 'boolean') values.push('false');
      else if (type === 'jsonb' || type === 'json') values.push(`'{}'::jsonb`);
      else values.push(`'级联测试-' || substr(gen_random_uuid()::text, 1, 8)`);
    }
    const rows = await h.dataSource.query(
      `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${values.join(', ')}) RETURNING id`,
    );
    return rows[0]?.id as string;
  }

  const countFor = async (table: string, id: string): Promise<number> => {
    const rows = await h.dataSource.query(`SELECT count(*)::int AS n FROM "${table}" WHERE workspace_id = $1`, [id]);
    return Number(rows[0]?.n ?? 0);
  };

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    // 自愈：上一次运行若在 beforeAll 里抛错，afterAll 不会执行（vitest 行为），会留下测试工作区。
    // 这里按名字前缀先清一遍；外键已就位，子行会随级联一起消失。
    await h.dataSource.query("DELETE FROM workspaces WHERE name LIKE $1", [`${PREFIX}-%`]);
    await h.dataSource.query("DELETE FROM platforms WHERE code LIKE 'cascade_probe%'");

    const ownerToken = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');

    workspaceId = await h.createWorkspace(`${PREFIX}-被测-${Date.now()}`);
    otherWorkspaceId = await h.createWorkspace(`${PREFIX}-旁观-${Date.now()}`);

    // 依赖顺序：contents → 内容子表；platforms → social_accounts
    contentId = await insertMinimal('contents', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
      title: `'级联测试内容'`,
    });
    platformId = await insertMinimal('platforms', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
      code: `'cascade_probe_' || substr(gen_random_uuid()::text, 1, 8)`,
      name: `'级联测试平台'`,
    });

    const contentChildren: Array<[string, string]> = [
      ['content_variants', `'${contentId}'`],
      ['content_revisions', `'${contentId}'`],
      ['content_reviews', `'${contentId}'`],
      ['analytics', `'${contentId}'`],
    ];
    for (const [table, content] of contentChildren) {
      await insertMinimal(table, { workspace_id: `'${workspaceId}'`, tenant_id: `'${TENANT}'`, content_id: content });
    }
    await insertMinimal('publish_tasks', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
      content_id: `'${contentId}'`,
    });
    await insertMinimal('social_accounts', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
      platform_id: `'${platformId}'`,
      platform_code: `'cascade_probe'`,
      account_name: `'级联测试账号'`,
      platform_account_id: `'cascade-1'`,
    });
    for (const table of ['track_events', 'media_assets', 'brand_knowledge', 'content_templates']) {
      await insertMinimal(table, { workspace_id: `'${workspaceId}'`, tenant_id: `'${TENANT}'` });
    }
    await insertMinimal('notifications', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
      title: `'级联测试通知'`,
      type: `'cascade_probe'`,
      status: `'unread'`,
      payload: `'{}'::jsonb`,
    });
    // workspace_members 不插：createWorkspace 已经把创建者作为 owner 写进去了（重复插会撞唯一约束），
    // 这里的目的是"验证级联会把成员关系带走"，用既有的那行即可。

    // 导出任务：产物在有效期内，删工作区后必须保留（SET NULL）
    exportJobId = await h.dataSource
      .query(
        `INSERT INTO workspace_export_jobs (id, tenant_id, workspace_id, created_at, updated_at, status, requested_by, include_media, include_audit, progress, file_path, size_bytes, checksum, expires_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now(), 'completed', (SELECT id FROM users LIMIT 1), false, false, 100, '/tmp/cascade-probe.zip', 1234, 'deadbeef', now() + interval '3 days')
         RETURNING id`,
        [TENANT, workspaceId],
      )
      .then((rows: Array<{ id: string }>) => rows[0].id);

    // B 类账本：审计 + AI 调用流水（都不该被删）
    await insertMinimal('audit_logs', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
      action: `'cascade_probe'`,
      resource_type: `'workspace'`,
    });
    await insertMinimal('ai_generations', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
    });
    // 账本行同样用"最小行"策略：NOT NULL 列（如 workspace_name）由 fill 逻辑补齐
    await insertMinimal('workspace_purge_batches', {
      workspace_id: `'${workspaceId}'`,
      tenant_id: `'${TENANT}'`,
      workspace_name: `'级联测试工作区'`,
      status: `'completed'`,
    });

    // 旁观工作区也造一行，用来证明删除不影响别人
    await insertMinimal('contents', {
      workspace_id: `'${otherWorkspaceId}'`,
      tenant_id: `'${TENANT}'`,
      title: `'旁观工作区内容'`,
    });
    // 前置守卫：造数失败就立刻报清楚，避免后续用空 id 跑出一堆误导性错误
    expect(ownerToken.length).toBeGreaterThan(0);
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(otherWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(contentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(platformId).toMatch(/^[0-9a-f-]{36}$/);
    expect(exportJobId).toMatch(/^[0-9a-f-]{36}$/);
    const memberRows = await h.dataSource.query('SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
    expect(Number(memberRows[0].n)).toBeGreaterThan(0);
  }, 180_000);

  afterAll(async () => {
    if (h) {
      // 旁观工作区的内容与工作区一起清（contents 有外键，顺序无关）
      await h.dataSource.query('DELETE FROM audit_logs WHERE workspace_id IN ($1, $2)', [workspaceId, otherWorkspaceId]);
      await h.dataSource.query('DELETE FROM ai_generations WHERE workspace_id IN ($1, $2)', [workspaceId, otherWorkspaceId]);
      await h.dataSource.query('DELETE FROM workspace_purge_batches WHERE workspace_id IN ($1, $2)', [workspaceId, otherWorkspaceId]);
      await h.dataSource.query('DELETE FROM workspace_export_jobs WHERE id = $1', [exportJobId]).catch(() => undefined);
      await h.dataSource.query("DELETE FROM workspaces WHERE name LIKE $1", [`${PREFIX}-%`]).catch(() => undefined);
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  it('删工作区：15 张表级联清空，导出任务保留并置空，账本表原样留下', async () => {
    // 前置断言：数据确实造出来了（否则测试是空转）
    for (const table of CASCADE_TABLES) {
      expect(await countFor(table, workspaceId), `${table} 造数失败`).toBeGreaterThan(0);
    }
    expect(await countFor('workspace_export_jobs', workspaceId)).toBe(1);
    for (const table of LEDGER_TABLES) {
      expect(await countFor(table, workspaceId), `${table} 造数失败`).toBeGreaterThan(0);
    }

    // 直接删父行（这就是"绕过 purge 直接删"的场景，外键负责兜底）
    await h.dataSource.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);

    // ① CASCADE：14 张表全部为 0
    for (const table of CASCADE_TABLES) {
      expect(await countFor(table, workspaceId), `${table} 未被级联清空`).toBe(0);
    }

    // ② SET NULL：导出任务行还在，但 workspace_id 为空
    const jobs = await h.dataSource.query('SELECT workspace_id, status FROM workspace_export_jobs WHERE id = $1', [exportJobId]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].workspace_id).toBeNull();
    expect(jobs[0].status).toBe('completed');

    // ③ 账本表：没有外键，行必须原样保留（合规留痕）
    for (const table of LEDGER_TABLES) {
      expect(await countFor(table, workspaceId), `${table} 被误删（不该有外键）`).toBeGreaterThan(0);
    }

    // ④ 旁观工作区不受影响
    expect(await countFor('contents', otherWorkspaceId)).toBe(1);

    // ⑤ 级联路径不会破坏应用：删掉的工作区列表里已不存在，但接口仍正常
    await request(h.app.getHttpServer())
      .get('/api/health')
      .expect(200);
  }, 120_000);
});
