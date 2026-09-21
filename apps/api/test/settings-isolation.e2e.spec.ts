/**
 * B0.5：租户 / 工作区配置隔离的**接口级**验证。
 *
 * 单元测试证明的是"代码带了过滤条件"，这里证明的是"经过真实 HTTP + 真实数据库之后，
 * 别的租户/工作区的值确实读不到、也写不进去"：
 *
 *   ① 工作区 B 改设置 → 工作区 A 读到的仍是自己的值（B0.5 之前的缓存键缺陷会让 A 读到 B）；
 *   ② 同工作区但属**别的租户**的诱饵行：接口不得采用它（租户过滤真实生效）；
 *   ③ `system_settings` 语义：每行必须同时有 `tenant_id` 与 `workspace_id`，**不存在全局行**；
 *   ④ 运行监控/权限矩阵这类运行时配置按工作区隔离（B 的改动不影响 A 的生效值）。
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, e2eCredentialsReady, type E2eHarness } from './support/e2e-harness';

const PREFIX = 'E2E配置隔离';
const DECOY_TENANT = '99999999-9999-9999-9999-999999999999';

describe.skipIf(!e2eCredentialsReady)(`${PREFIX}：设置读取的租户 / 工作区隔离`, () => {
  let h: E2eHarness;
  let workspaceB = '';
  let tokenB = '';
  let tokenA = '';
  const server = () => h.app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const readSetting = async (token: string, key: string): Promise<{ value: string; source: string } | undefined> => {
    const response = await request(server()).get('/api/settings').set(auth(token)).expect(200);
    const groups = response.body.data as Array<{ items: Array<{ key: string; value: string; source: string }> }>;
    return groups.flatMap((group) => group.items).find((item) => item.key === key);
  };

  beforeAll(async () => {
    h = await createHarness(PREFIX, { requireApproval: false });
    tokenA = await h.login(process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
    workspaceB = await h.createWorkspace(`${PREFIX}-B-${Date.now()}`);
    tokenB = await h.switchWorkspace(tokenA, workspaceB);
  }, 120_000);

  afterAll(async () => {
    if (h) {
      // 清掉诱饵行（同工作区、别的租户）再交给 harness 清理
      await h.dataSource.query('DELETE FROM system_settings WHERE tenant_id = $1', [DECOY_TENANT]).catch(() => undefined);
      await h.cleanup();
      await h.close();
    }
  }, 120_000);

  it('工作区 B 改的设置，工作区 A 读不到（缓存与快照都按工作区隔离）', async () => {
    // A 先写一个值（同时把 A 的值放进缓存）
    await request(server()).put('/api/settings').set(auth(tokenA)).send({ items: [{ key: 'SITE_NAME', value: '站点-A' }] }).expect(200);
    expect((await readSetting(tokenA, 'SITE_NAME'))?.value).toBe('站点-A');

    // B 改同名键：不能影响 A（B0.5 之前会立刻串到 A）
    await request(server()).put('/api/settings').set(auth(tokenB)).send({ items: [{ key: 'SITE_NAME', value: '站点-B' }] }).expect(200);

    expect((await readSetting(tokenB, 'SITE_NAME'))?.value).toBe('站点-B');
    expect((await readSetting(tokenA, 'SITE_NAME'))?.value).toBe('站点-A');

    // 数据库层面也是两行（各带自己的租户与工作区）
    const rows = await h.dataSource.query(
      "SELECT workspace_id, tenant_id, value FROM system_settings WHERE key = 'SITE_NAME' AND workspace_id IN ($1, $2) ORDER BY value",
      [workspaceB, await h.defaultWorkspaceId()],
    );
    expect(rows.length).toBe(2);
    for (const row of rows as Array<{ tenant_id: string; workspace_id: string }>) {
      expect(row.tenant_id).toBeTruthy();
      expect(row.workspace_id).toBeTruthy();
    }
  }, 90_000);

  it('同工作区重复键被唯一索引挡住；别的租户/工作区的行读不到（双层防线）', async () => {
    const workspaceA = await h.defaultWorkspaceId();

    // 防线 1（数据库）：system_settings 上有 UNIQUE(workspace_id, key)，
    // 所以"同一个工作区里塞一行别家租户的同名配置"这种脏数据**根本插不进去**。
    const uniqueIndex = await h.dataSource.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'system_settings' AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%workspace_id%'`,
    );
    expect(uniqueIndex.some((row: { indexdef: string }) => row.indexdef.includes('(workspace_id, key)'))).toBe(true);

    let rejected = false;
    try {
      await h.dataSource.query(
        `INSERT INTO system_settings (id, tenant_id, workspace_id, created_at, updated_at, key, value, is_secret, updated_by)
         VALUES (gen_random_uuid(), $1, $2, now(), now(), 'SITE_NAME', '诱饵站点（别的租户）', false, NULL)`,
        [DECOY_TENANT, workspaceA],
      );
    } catch {
      rejected = true;
    }
    expect(rejected, '唯一索引应当拒绝"同工作区 + 同名键"的第二行').toBe(true);

    // 防线 2（应用层租户过滤）：换一个工作区 id 造一行别的租户的配置——它对工作区 A 必须完全不可见
    await h.dataSource.query(
      `INSERT INTO system_settings (id, tenant_id, workspace_id, created_at, updated_at, key, value, is_secret, updated_by)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), 'SITE_NAME', '诱饵站点（别的租户）', false, NULL)`,
      [DECOY_TENANT, '88888888-8888-8888-8888-888888888888'],
    );
    const setting = await readSetting(tokenA, 'SITE_NAME');
    expect(setting?.value).toBe('站点-A');
    expect(setting?.value).not.toContain('诱饵');

    await h.dataSource.query('DELETE FROM system_settings WHERE tenant_id = $1', [DECOY_TENANT]);
  }, 90_000);

  it('system_settings 语义：每行必须同时有 tenant_id 与 workspace_id，不存在全局行', async () => {
    const nulls = await h.dataSource.query(
      'SELECT count(*)::int AS n FROM system_settings WHERE workspace_id IS NULL OR tenant_id IS NULL',
    );
    expect(Number(nulls[0].n), 'system_settings 不允许出现"全局行"（平台默认值走 .env / 代码默认）').toBe(0);
  }, 60_000);

  it('运行时配置（上传上限）按工作区生效：B 的设置不影响 A 的实际限制', async () => {
    await request(server())
      .put('/api/settings')
      .set(auth(tokenB))
      .send({ items: [{ key: 'MEDIA_MAX_FILE_MB', value: '7' }] })
      .expect(200);

    const inB = (await readSetting(tokenB, 'MEDIA_MAX_FILE_MB'))?.value;
    const inA = (await readSetting(tokenA, 'MEDIA_MAX_FILE_MB'))?.value;
    expect(inB).toBe('7');
    expect(inA).not.toBe('7'); // A 仍是自己的值（或 env 默认 50）
  }, 90_000);
});
