import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { AuditService } from '../../../audit/audit.service';
import type { CryptoService } from '../../../common/crypto.service';
import type { WorkspaceContextService } from '../../../common/workspace-context.service';
import type { WorkspaceExportJob } from '../entities/workspace-export-job.entity';
import { WorkspaceExportService } from '../workspace-export.service';
import type { WorkspaceService } from '../workspace.service';

/**
 * B0.4 第 5 步：导出任务外键改为 `ON DELETE SET NULL` 之后的代码行为。
 *
 * 背景（第 1 步设计与第 5 步规则表的矛盾，定稿见 docs/DESIGN-外键补全-第5步.md）：
 * 工作区被永久清除后，导出任务行要**保留**、`workspace_id` 置空，产物在 7 天有效期内仍可下载。
 * 于是三处代码必须认得"工作区已不存在"这种任务：
 *   1. `createDownloadLink()`：只允许**原申请人本人**在有效期内取回（否则任何人都能拿别人的数据）；
 *   2. `resolveDownload()`：不能再用 `workspace_id` 匹配（置空后永远匹配不上，已发出的链接会莫名失效）；
 *   3. `pruneExpired()`：产物删掉后，这类没有归属的任务行一并删除（否则永久堆积）。
 */

const WS_ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';
const OWNER = 'user-owner';
const STRANGER = 'user-stranger';

type JobOverrides = Partial<Record<keyof WorkspaceExportJob, unknown>>;

function job(overrides: JobOverrides = {}): WorkspaceExportJob {
  return {
    id: JOB_ID,
    tenantId: 't-1',
    workspaceId: WS_ID,
    status: 'completed',
    requestedBy: OWNER,
    requestedByName: '申请人',
    filePath: `/www/wwwroot/mediaflow/uploads/exports/${WS_ID}/${JOB_ID}.zip`,
    sizeBytes: '5233',
    checksum: 'deadbeefcafe',
    progress: 100,
    errorMessage: null,
    expiresAt: new Date(Date.now() + 3 * 86400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as WorkspaceExportJob;
}

function build(options: { jobRow?: WorkspaceExportJob | null; verifyHmac?: boolean; expiredJobs?: WorkspaceExportJob[] } = {}) {
  const jobs = {
    findOne: vi.fn(async () => (options.jobRow === undefined ? job() : options.jobRow)),
    update: vi.fn(async () => ({ affected: 1 })),
    delete: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      getMany: vi.fn(async () => options.expiredJobs ?? []),
    })),
  } as unknown as Repository<WorkspaceExportJob>;

  const requireWorkspaceRole = vi.fn(async () => ({
    workspace: { id: WS_ID, slug: 'default', tenantId: 't-1' },
    roleCodes: ['owner'],
  }));
  const workspaces = { requireWorkspaceRole } as unknown as WorkspaceService;
  const workspaceContext = { current: vi.fn(async () => ({ workspaceId: WS_ID, tenantId: 't-1' })) } as unknown as WorkspaceContextService;
  const crypto = {
    hmac: vi.fn(() => 'signature'),
    verifyHmac: vi.fn(() => options.verifyHmac ?? true),
  } as unknown as CryptoService;
  const record = vi.fn(async (_input: Record<string, unknown>) => undefined);
  const audit = { record } as unknown as AuditService;
  const redis = { set: vi.fn(async () => 'OK') } as unknown as Redis;
  const dataSource = { query: vi.fn(async () => [{ slug: 'default' }]) } as unknown as DataSource;

  const service = new WorkspaceExportService(jobs, dataSource, workspaces, workspaceContext, crypto, audit, redis);
  return { service, jobs, requireWorkspaceRole, record };
}

/** 造一个与路径参数匹配的合法令牌载荷（签名由 crypto 替身放行）。 */
const mintToken = (workspaceId: string, jobId: string): string => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const payload = `${workspaceId}|${jobId}|${exp}|nonce`;
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.signature`;
};

const actionsOf = (record: ReturnType<typeof vi.fn>): string[] =>
  record.mock.calls.map((call) => (call[0] as unknown as { action: string }).action);

describe('B0.4 第 5 步：工作区已被清除后的导出链路', () => {
  afterEach(() => vi.clearAllMocks());

  describe('createDownloadLink：申请一次性下载链接', () => {
    it('工作区还在（owner 申请）：返回链接，并按目标工作区校验角色', async () => {
      const { service, requireWorkspaceRole } = build({ jobRow: job() });
      const result = await service.createDownloadLink(WS_ID, JOB_ID, OWNER);

      expect(requireWorkspaceRole).toHaveBeenCalledWith(WS_ID, OWNER, ['owner', 'admin']);
      expect(result.url).toContain(`/api/workspaces/${WS_ID}/export/${JOB_ID}/download?token=`);
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('工作区已被永久清除：原申请人可以取回，并写审计（不再要求工作区角色）', async () => {
      const { service, requireWorkspaceRole, record } = build({ jobRow: job({ workspaceId: null }) });
      const result = await service.createDownloadLink(WS_ID, JOB_ID, OWNER);

      expect(requireWorkspaceRole).not.toHaveBeenCalled();
      expect(result.url).toContain(`/api/workspaces/${WS_ID}/export/${JOB_ID}/download?token=`);
      expect(actionsOf(record)).toContain('workspace.export.link_issued_after_purge');
      const payload = (record.mock.calls[0][0] as unknown as { payload: { purgedWorkspaceId: string } }).payload;
      expect(payload.purgedWorkspaceId).toBe(WS_ID);
    });

    it('工作区已被永久清除：**其他人拿不到**（403），产物不会变成公开资源', async () => {
      const { service, record } = build({ jobRow: job({ workspaceId: null }) });

      await expect(service.createDownloadLink(WS_ID, JOB_ID, STRANGER)).rejects.toThrow(/只有原申请人可以取回/);
      expect(record).not.toHaveBeenCalled();
    });

    it('工作区已被永久清除且任务没记录申请人：一律拒绝（缺证据不放行）', async () => {
      const { service } = build({ jobRow: job({ workspaceId: null, requestedBy: null }) });
      await expect(service.createDownloadLink(WS_ID, JOB_ID, OWNER)).rejects.toThrow(/只有原申请人可以取回/);
    });

    it('路径里的工作区与任务记录不符：404（不泄露任务是否存在）', async () => {
      const { service } = build({ jobRow: job() });
      await expect(service.createDownloadLink('99999999-9999-9999-9999-999999999999', JOB_ID, OWNER)).rejects.toThrow(/导出任务不存在/);
    });

    it('产物已过期：即使工作区被清除也不给链接', async () => {
      const { service } = build({ jobRow: job({ workspaceId: null, expiresAt: new Date(Date.now() - 1000) }) });
      await expect(service.createDownloadLink(WS_ID, JOB_ID, OWNER)).rejects.toThrow(/导出产物已过期/);
    });

    it('链接里的令牌是 HMAC 签名载荷（工作区 + 任务 + 过期时间，不暴露明文 id 之外的信息）', async () => {
      const { service } = build({ jobRow: job() });
      const result = await service.createDownloadLink(WS_ID, JOB_ID, OWNER);
      const token = decodeURIComponent(result.url.split('token=')[1] ?? '');
      const payload = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
      expect(payload.split('|')[0]).toBe(WS_ID);
      expect(payload.split('|')[1]).toBe(JOB_ID);
      expect(token.split('.').length).toBe(2);
    });
  });

  describe('resolveDownload：凭令牌下载', () => {
    it('工作区已被清除（workspace_id 为空）时，已发出的链接仍然可用', async () => {
      // filePath 必须指向真实存在的文件：resolveDownload 会做 existsSync 兜底（产物可能已被清理任务删掉）
      const { service } = build({ jobRow: job({ workspaceId: null, filePath: `${process.cwd()}/package.json` }) });
      const result = await service.resolveDownload(WS_ID, JOB_ID, mintToken(WS_ID, JOB_ID));

      expect(result.path).toContain('package.json');
      expect(result.fileName).toContain('default');
      expect(result.sizeBytes).toBe(5233);
    });

    it('令牌里的工作区与任务记录不一致：拒绝（防越权拼接）', async () => {
      const { service } = build({ jobRow: job({ workspaceId: '44444444-4444-4444-4444-444444444444' }) });
      await expect(service.resolveDownload(WS_ID, JOB_ID, mintToken(WS_ID, JOB_ID))).rejects.toThrow(/导出产物不存在/);
    });

    it('签名不对：拒绝', async () => {
      const { service } = build({ jobRow: job(), verifyHmac: false });
      await expect(service.resolveDownload(WS_ID, JOB_ID, mintToken(WS_ID, JOB_ID))).rejects.toThrow(/下载链接无效/);
    });
  });

  describe('pruneExpired：过期产物的清理', () => {
    it('属于已清除工作区的过期任务：产物删掉后连行一起删（否则永久堆积）', async () => {
      const { service, jobs } = build({
        expiredJobs: [job({ workspaceId: null, filePath: '/tmp/cascade-probe-not-exists.zip' })],
      });
      const result = await service.pruneExpired();

      expect(result.removed).toBe(1);
      expect(jobs.delete).toHaveBeenCalled();
      expect(jobs.update).not.toHaveBeenCalled();
    });

    it('工作区还在的过期任务：只标记 expired、保留行（那是工作区自己的历史）', async () => {
      const { service, jobs } = build({ expiredJobs: [job({ filePath: '/tmp/cascade-probe-not-exists.zip' })] });
      const result = await service.pruneExpired();

      expect(result.removed).toBe(1);
      expect(jobs.update).toHaveBeenCalled();
      expect(jobs.delete).not.toHaveBeenCalled();
    });
  });
});
