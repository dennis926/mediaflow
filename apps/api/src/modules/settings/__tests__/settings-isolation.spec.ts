import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { AuditService } from '../../../audit/audit.service';
import type { CryptoService } from '../../../common/crypto.service';
import { WorkspaceScope, runInWorkspaceScope } from '../../../common/workspace-context.store';
import type { WorkspaceContextService } from '../../../common/workspace-context.service';
import { SystemSetting } from '../entities/system-setting.entity';
import { SettingsService } from '../settings.service';
import {
  applyRuntimeConfig,
  dropWorkspaceRuntimeConfig,
  runtime,
  setFallbackWorkspace,
} from '../runtime-config';

/**
 * B0.5：租户级配置隔离。
 *
 * 修掉的两个真实缺陷：
 *   ① **缓存键只按 key**：`SettingsService.cache` 是 `Map<key, value>`，多工作区下 A 公司会读到
 *      B 公司（或默认工作区）的值——AI 密钥这类敏感项就是越权读取。
 *   ② **运行时快照是进程单例**：任何工作区保存设置都会覆盖全局 `snapshot`，
 *      于是 A 改权限矩阵会立刻影响 B。
 * 本套件用"切工作区立刻改变结果"的正反两面断言把这两点钉死。
 */

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const WS_A = 'workspace-a';
const WS_B = 'workspace-b';

interface Row {
  id: string;
  tenantId: string;
  workspaceId: string;
  key: string;
  value: string;
  isSecret: boolean;
}

function build(rows: Row[]) {
  const store = new Map(rows.map((row) => [`${row.tenantId}::${row.workspaceId}::${row.key}`, row]));
  const findOne = vi.fn(async ({ where }: { where: Record<string, string> }) => {
    const key = `${where.tenantId}::${where.workspaceId}::${where.key}`;
    return store.get(key) ?? null;
  });
  const find = vi.fn(async ({ where }: { where: Record<string, string> }) =>
    [...store.values()].filter(
      (row) => row.tenantId === where.tenantId && row.workspaceId === where.workspaceId,
    ),
  );
  const repository = {
    findOne,
    find,
    delete: vi.fn(async () => ({ affected: 1 })),
    update: vi.fn(async () => ({ affected: 1 })),
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: unknown) => value),
  } as unknown as Repository<SystemSetting>;

  const crypto = {
    decrypt: vi.fn((value: string) => `plain:${value}`),
    encrypt: vi.fn((value: string) => `enc:${value}`),
    mask: vi.fn((value: string) => `${value.slice(0, 4)}****`),
  } as unknown as CryptoService;

  let scope: WorkspaceScope = { tenantId: TENANT_A, workspaceId: WS_A };
  const workspaceContext = { current: vi.fn(async () => scope) } as unknown as WorkspaceContextService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;

  const service = new SettingsService(repository, crypto, workspaceContext, audit);
  return {
    service,
    findOne,
    find,
    repository,
    setScope: (next: WorkspaceScope) => {
      scope = next;
    },
  };
}

describe('B0.5：设置读取的租户 / 工作区隔离', () => {
  afterEach(() => {
    // 清掉模块级运行时快照，避免用例互相影响
    dropWorkspaceRuntimeConfig(WS_A);
    dropWorkspaceRuntimeConfig(WS_B);
    setFallbackWorkspace(null);
    applyRuntimeConfig({});
  });

  it('缓存按「租户 + 工作区」隔离：切工作区后读到的是自己的值，不会串（原缺陷：只按 key 缓存）', async () => {
    const { service, setScope } = build([
      { id: '1', tenantId: TENANT_A, workspaceId: WS_A, key: 'AI_API_KEY', value: 'A-KEY', isSecret: true },
      { id: '2', tenantId: TENANT_B, workspaceId: WS_B, key: 'AI_API_KEY', value: 'B-KEY', isSecret: true },
    ]);

    // 同一个进程先读 A、再读 B：第一次结果被缓存，若缓存键不含工作区就会把 A 的密钥返回给 B
    expect(await service.get('AI_API_KEY')).toBe('plain:A-KEY');
    setScope({ tenantId: TENANT_B, workspaceId: WS_B });
    expect(await service.get('AI_API_KEY')).toBe('plain:B-KEY');

    // 切回 A：仍是 A 的值（说明两份缓存并存，而不是互相覆盖）
    setScope({ tenantId: TENANT_A, workspaceId: WS_A });
    expect(await service.get('AI_API_KEY')).toBe('plain:A-KEY');
  });

  it('查询条件必须同时带租户与工作区（只按工作区过滤会读到"同工作区属别人"的行）', async () => {
    const { service, findOne } = build([
      { id: '1', tenantId: TENANT_A, workspaceId: WS_A, key: 'SITE_NAME', value: '站点A', isSecret: false },
    ]);

    await service.get('SITE_NAME');
    const where = (findOne.mock.calls[0][0] as unknown as { where: Record<string, string> }).where;
    expect(where.tenantId).toBe(TENANT_A);
    expect(where.workspaceId).toBe(WS_A);
    expect(where.key).toBe('SITE_NAME');
  });

  it('同工作区但属别的租户的行读不到（模拟脏数据/越权写入）', async () => {
    const { service } = build([
      { id: '1', tenantId: TENANT_B, workspaceId: WS_A, key: 'SITE_NAME', value: '别人的站点', isSecret: false },
    ]);

    // 当前作用域是 TENANT_A + WS_A；上面这行属于 TENANT_B → 必须读不到（回退到环境变量/未配置）
    expect(await service.get('SITE_NAME')).toBeNull();
  });

  it('list() 只返回本租户本工作区的行，且查询条件带双 id', async () => {
    const { service, find } = build([
      { id: '1', tenantId: TENANT_A, workspaceId: WS_A, key: 'SITE_NAME', value: '站点A', isSecret: false },
      { id: '2', tenantId: TENANT_B, workspaceId: WS_A, key: 'SITE_NAME', value: '站点B', isSecret: false },
      { id: '3', tenantId: TENANT_A, workspaceId: WS_B, key: 'SITE_NAME', value: '站点A2', isSecret: false },
    ]);

    const groups = await service.list();
    const site = groups.flatMap((group) => group.items).find((item) => item.key === 'SITE_NAME');
    expect(site?.value).toBe('站点A');
    expect(site?.source).toBe('db');

    const where = (find.mock.calls[0][0] as unknown as { where: Record<string, string> }).where;
    expect(where).toEqual({ tenantId: TENANT_A, workspaceId: WS_A });
  });

  it('updateMany 写入的行带当前租户与工作区，且更新前按双 id 查重', async () => {
    const { service, repository, findOne } = build([]);
    await service.updateMany([{ key: 'SITE_NAME', value: '新站点' }], { id: 'u1', name: '管理员' });

    const created = (repository.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(created.tenantId).toBe(TENANT_A);
    expect(created.workspaceId).toBe(WS_A);
    const where = (findOne.mock.calls[0][0] as unknown as { where: Record<string, string> }).where;
    expect(where.tenantId).toBe(TENANT_A);
    expect(where.workspaceId).toBe(WS_A);
  });
});

describe('B0.5：运行时快照按工作区隔离', () => {
  afterEach(() => {
    dropWorkspaceRuntimeConfig(WS_A);
    dropWorkspaceRuntimeConfig(WS_B);
    setFallbackWorkspace(null);
    applyRuntimeConfig({});
  });

  it('保存 A 的设置只影响 A：作用域切到 B 时读到的仍是 B（或兜底）的配置（原缺陷：全局单例被覆盖）', () => {
    applyRuntimeConfig({ SITE_NAME: '默认站点' }, undefined, null);
    setFallbackWorkspace('default-ws');
    applyRuntimeConfig({ SITE_NAME: '默认站点' }, undefined, 'default-ws');

    applyRuntimeConfig({ SITE_NAME: 'A 的站点', MEDIA_MAX_FILE_MB: '10' }, undefined, WS_A);

    const inA = runInWorkspaceScope({ tenantId: TENANT_A, workspaceId: WS_A }, () => ({
      name: runtime().site.name,
      upload: runtime().media.maxFileMb,
    }));
    const inB = runInWorkspaceScope({ tenantId: TENANT_B, workspaceId: WS_B }, () => runtime().site.name);
    const noScope = runtime().site.name;

    expect(inA.name).toBe('A 的站点');
    expect(inA.upload).toBe(10);
    // B 没有自己的快照 → 回退到兜底工作区（默认工作区）的配置，而不是 A 的
    expect(inB).toBe('默认站点');
    expect(noScope).toBe('默认站点');

    // 再让 B 保存设置：A 完全不受影响
    applyRuntimeConfig({ SITE_NAME: 'B 的站点' }, undefined, WS_B);
    expect(runInWorkspaceScope({ tenantId: TENANT_A, workspaceId: WS_A }, () => runtime().site.name)).toBe('A 的站点');
    expect(runInWorkspaceScope({ tenantId: TENANT_B, workspaceId: WS_B }, () => runtime().site.name)).toBe('B 的站点');
    expect(runtime().site.name).toBe('默认站点');
  });

  it('工作区被永久清除后丢弃其快照（内存里不留死租户配置）', () => {
    setFallbackWorkspace('default-ws');
    applyRuntimeConfig({ SITE_NAME: '默认站点' }, undefined, 'default-ws');
    applyRuntimeConfig({ SITE_NAME: '将被清除的站点' }, undefined, WS_B);

    expect(runInWorkspaceScope({ tenantId: TENANT_B, workspaceId: WS_B }, () => runtime().site.name)).toBe('将被清除的站点');
    dropWorkspaceRuntimeConfig(WS_B);
    // 丢弃后回退到兜底工作区，而不是继续用已删除工作区的配置
    expect(runInWorkspaceScope({ tenantId: TENANT_B, workspaceId: WS_B }, () => runtime().site.name)).toBe('默认站点');
    dropWorkspaceRuntimeConfig('default-ws');
  });

  it('无作用域时（启动、全局后台任务）用兜底工作区的配置，保持与改造前一致的行为', () => {
    setFallbackWorkspace('default-ws');
    applyRuntimeConfig({ SITE_NAME: '运维配置的站点', PUBLISH_WORKER_ENABLED: 'false' }, undefined, 'default-ws');
    expect(runtime().site.name).toBe('运维配置的站点');
    expect(runtime().publish.workerEnabled).toBe(false);
    dropWorkspaceRuntimeConfig('default-ws');
  });
});
