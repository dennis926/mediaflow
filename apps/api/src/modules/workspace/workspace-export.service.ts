import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import JSZip from 'jszip';
import Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { WorkspaceExportJob, jobWorkspaceId } from './entities/workspace-export-job.entity';
import { WorkspaceService } from './workspace.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';

export interface ExportJobView {
  id: string;
  status: string;
  progress: number;
  sizeBytes: number | null;
  checksum: string | null;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
  /** 完成后才有的下载入口（需另行申请一次性链接） */
  downloadEndpoint?: string;
}

/** 导出的数据表与其在 ZIP 中的文件名（全部按 workspace_id 过滤）。 */
const EXPORT_TABLES: Array<{ table: string; file: string; order?: string }> = [
  { table: 'contents', file: 'contents' },
  { table: 'content_variants', file: 'content_variants' },
  { table: 'content_revisions', file: 'content_revisions' },
  { table: 'content_reviews', file: 'content_reviews' },
  { table: 'publish_tasks', file: 'publish_tasks' },
  { table: 'brand_knowledge', file: 'brand_knowledge' },
  { table: 'content_templates', file: 'content_templates' },
  { table: 'media_assets', file: 'media_assets' },
  { table: 'social_accounts', file: 'social_accounts' },
  { table: 'analytics', file: 'analytics' },
  { table: 'track_events', file: 'track_events' },
];

/** 导出时**必须剔除**的凭证列：导出包会被下载到本地，绝不能带平台令牌。 */
const REDACTED_COLUMNS: Record<string, string[]> = {
  social_accounts: ['access_token', 'refresh_token'],
};

/**
 * 工作区数据导出（B0.4 第 3 步）。
 *
 * 约束（用户要求）：
 *   - 5GB 硬上限，超过直接拒绝（不截断）
 *   - 同一工作区同时只允许 1 个导出任务（重复请求 409）
 *   - 产物 7 天后自动清理，清理前写审计
 *   - 下载走一次性签名链接（15 分钟有效，用过即失效）
 *   - 平台凭证列脱敏，绝不进入导出包
 */
@Injectable()
export class WorkspaceExportService {
  private readonly logger = new Logger(WorkspaceExportService.name);
  private static readonly MAX_BYTES = 5 * 1024 * 1024 * 1024;
  private static readonly TOKEN_TTL_SECONDS = 15 * 60;
  private static readonly ARTIFACT_TTL_DAYS = 7;

  constructor(
    @InjectRepository(WorkspaceExportJob) private readonly jobs: Repository<WorkspaceExportJob>,
    private readonly dataSource: DataSource,
    private readonly workspaces: WorkspaceService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private exportDir(workspaceId: string): string {
    const dir = join(process.cwd(), '../../uploads/exports', workspaceId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private toView(job: WorkspaceExportJob): ExportJobView {
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      sizeBytes: job.sizeBytes === null ? null : Number(job.sizeBytes),
      checksum: job.checksum,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      error: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      ...(job.status === 'completed' && jobWorkspaceId(job)
        ? { downloadEndpoint: `/api/workspaces/${jobWorkspaceId(job)}/export/${job.id}/link` }
        : {}),
    };
  }

  /** 申请导出：权限（目标工作区 owner/admin）→ 并发校验 → 体量预检 → 建任务并异步执行。 */
  async requestExport(
    workspaceId: string,
    userId: string,
    actor: { id?: string | null; name?: string | null },
    dto: { includeMedia?: boolean; includeAudit?: boolean; note?: string },
  ): Promise<ExportJobView> {
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, ['owner', 'admin']);

    const running = await this.jobs.count({ where: { workspaceId, status: 'running' } });
    const queued = await this.jobs.count({ where: { workspaceId, status: 'queued' } });
    if (running + queued > 0) throw new ConflictException('该工作区已有正在进行的导出任务，请等待其完成');

    const includeMedia = dto.includeMedia !== false;
    const estimate = await this.estimateSize(workspaceId, includeMedia);
    if (estimate > WorkspaceExportService.MAX_BYTES) {
      throw new PayloadTooLargeException(
        `预计导出约 ${(estimate / 1024 / 1024 / 1024).toFixed(2)}GB，超过 5GB 上限。` +
          '请改用 includeMedia=false 只导出数据（不含素材二进制），或在清理素材后重试。',
      );
    }

    const job = await this.jobs.save(
      this.jobs.create({
        tenantId: (await this.workspaces.requireWorkspaceRole(workspaceId, userId, ['owner', 'admin'])).workspace.tenantId,
        workspaceId,
        status: 'queued',
        requestedBy: actor.id ?? null,
        requestedByName: actor.name ?? null,
        includeMedia,
        includeAudit: dto.includeAudit !== false,
        note: dto.note ?? null,
        progress: 0,
        expiresAt: new Date(Date.now() + WorkspaceExportService.ARTIFACT_TTL_DAYS * 24 * 60 * 60 * 1000),
      }),
    );

    await this.audit
      .record({
        action: 'workspace.export.requested',
        resourceType: 'workspace_export',
        resourceId: job.id,
        tenantId: job.tenantId,
        workspaceId,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        payload: { includeMedia, includeAudit: dto.includeAudit !== false, estimatedBytes: estimate, note: dto.note ?? null },
      })
      .catch(() => undefined);

    // 异步执行：接口立即返回 jobId，前端轮询状态
    void this.runJob(job.id).catch((error: unknown) => {
      this.logger.error(`导出任务异常：${error instanceof Error ? error.message : String(error)}`);
    });

    return this.toView(job);
  }

  /** 预估体量：素材二进制 + 知识库留档 + 数据量粗估（每行按 2KB 计）。 */
  async estimateSize(workspaceId: string, includeMedia: boolean): Promise<number> {
    const counts = await Promise.all(
      EXPORT_TABLES.map(async (item) => {
        const rows = await this.dataSource.query(`SELECT count(*)::int AS n FROM ${item.table} WHERE workspace_id = $1`, [workspaceId]);
        return Number(rows[0]?.n ?? 0);
      }),
    );
    const rowBytes = counts.reduce((sum, n) => sum + n, 0) * 2048;
    if (!includeMedia) return rowBytes;

    const media = await this.dataSource.query(
      'SELECT coalesce(sum(size), 0)::bigint AS bytes FROM media_assets WHERE workspace_id = $1',
      [workspaceId],
    );
    const knowledge = await this.dataSource.query(
      "SELECT coalesce(sum(length(content)), 0)::bigint AS bytes FROM brand_knowledge WHERE workspace_id = $1",
      [workspaceId],
    );
    return rowBytes + Number(media[0]?.bytes ?? 0) + Number(knowledge[0]?.bytes ?? 0);
  }

  /** 真正生成 ZIP（流式写出，素材以文件流形式进包，不整块载入内存）。 */
  async runJob(jobId: string): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) return;
    const startedAt = Date.now();
    await this.jobs.update({ id: jobId }, { status: 'running', progress: 5, errorMessage: null });

    try {
      const zip = new JSZip();
      const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
      const counts: Record<string, number> = {};

      for (const item of EXPORT_TABLES) {
        const rows: Array<Record<string, unknown>> = await this.dataSource.query(
          `SELECT * FROM ${item.table} WHERE workspace_id = $1`,
          [job.workspaceId],
        );
        const redacted = REDACTED_COLUMNS[item.table] ?? [];
        const safeRows = rows.map((row) => {
          const clone: Record<string, unknown> = { ...row };
          for (const column of redacted) {
            if (column in clone) {
              clone[column] = clone[column] ? '<已脱敏：导出不包含平台凭证>' : null;
            }
          }
          return clone;
        });
        const jsonl = safeRows.map((row) => JSON.stringify(row)).join('\n');
        zip.file(`data/${item.file}.jsonl`, jsonl);
        counts[item.table] = safeRows.length;
        manifestFiles.push({
          path: `data/${item.file}.jsonl`,
          bytes: Buffer.byteLength(jsonl, 'utf8'),
          sha256: createHash('sha256').update(jsonl).digest('hex'),
        });
      }

      // 素材二进制（流式读取）
      let mediaFiles = 0;
      if (job.includeMedia) {
        const assets: Array<{ stored_name: string; size: number | string }> = await this.dataSource.query(
          'SELECT stored_name, size FROM media_assets WHERE workspace_id = $1 AND deleted_at IS NULL',
          [job.workspaceId],
        );
        const dir = join(process.cwd(), '../../uploads/media');
        for (const asset of assets) {
          const filePath = join(dir, asset.stored_name);
          if (!existsSync(filePath)) continue;
          const bytes = statSync(filePath).size;
          zip.file(`media/${asset.stored_name}`, createReadStream(filePath));
          manifestFiles.push({ path: `media/${asset.stored_name}`, bytes, sha256: await this.hashFile(filePath) });
          mediaFiles += 1;
        }
      }

      // 审计日志（可选）
      if (job.includeAudit) {
        const rows: Array<Record<string, unknown>> = await this.dataSource.query(
          'SELECT * FROM audit_logs WHERE workspace_id = $1 ORDER BY created_at ASC',
          [job.workspaceId],
        );
        const jsonl = rows.map((row) => JSON.stringify(row)).join('\n');
        zip.file('audit/audit_logs.jsonl', jsonl);
        counts.audit_logs = rows.length;
        manifestFiles.push({
          path: 'audit/audit_logs.jsonl',
          bytes: Buffer.byteLength(jsonl, 'utf8'),
          sha256: createHash('sha256').update(jsonl).digest('hex'),
        });
      }

      await this.jobs.update({ id: jobId }, { progress: 60 });

      const workspaceRows = await this.dataSource.query('SELECT id, name, slug, tenant_id, created_at FROM workspaces WHERE id = $1', [
        job.workspaceId,
      ]);
      const manifest = {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        workspace: workspaceRows[0]
          ? { id: workspaceRows[0].id, name: workspaceRows[0].name, slug: workspaceRows[0].slug, tenantId: workspaceRows[0].tenant_id, createdAt: workspaceRows[0].created_at }
          : { id: job.workspaceId },
        requestedBy: { id: job.requestedBy, name: job.requestedByName },
        options: { includeMedia: job.includeMedia, includeAudit: job.includeAudit, note: job.note },
        counts,
        mediaFiles,
        redactedColumns: REDACTED_COLUMNS,
        files: manifestFiles,
        totalBytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
        checksum: createHash('sha256').update(manifestFiles.map((file) => `${file.path}:${file.sha256}`).join('\n')).digest('hex'),
      };
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      zip.file(
        'README.txt',
        [
          'MediaFlow 工作区数据导出包',
          '',
          '目录说明：',
          '  manifest.json        导出清单（每数据表行数、每个文件的 sha256、总大小）',
          '  data/*.jsonl         业务数据，每行一条 JSON（便于用脚本处理）',
          '  media/               素材二进制（includeMedia=false 时为空）',
          '  audit/audit_logs.jsonl  审计日志（includeAudit=false 时不存在）',
          '',
          '安全说明：平台凭证（access_token / refresh_token）已在导出时脱敏，不包含在包内。',
          `导出时间：${manifest.exportedAt}`,
          `工作区：${manifest.workspace.name ?? manifest.workspace.id}`,
          '',
        ].join('\n'),
      );

      const target = join(this.exportDir(job.workspaceId), `${job.id}.zip`);
      const hasher = createHash('sha256');
      const stream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' });
      await pipeline(
        stream,
        new Transform({
          transform(chunk, _encoding, callback) {
            hasher.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(target, { mode: 0o600 }),
      );

      const sizeBytes = statSync(target).size;
      await this.jobs.update(
        { id: jobId },
        { status: 'completed', progress: 100, filePath: target, sizeBytes: String(sizeBytes), checksum: hasher.digest('hex') },
      );
      await this.audit
        .record({
          action: 'workspace.export.completed',
          resourceType: 'workspace_export',
          resourceId: jobId,
          tenantId: job.tenantId,
          workspaceId: job.workspaceId,
          payload: { sizeBytes, counts, rows: Object.values(counts).reduce((sum, n) => sum + n, 0), elapsedMs: Date.now() - startedAt },
        })
        .catch(() => undefined);
      this.logger.log(`导出完成：${job.workspaceId} → ${(sizeBytes / 1024).toFixed(1)}KB，用时 ${Date.now() - startedAt}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobs.update({ id: jobId }, { status: 'failed', errorMessage: message, progress: 0 });
      await this.audit
        .record({
          action: 'workspace.export.failed',
          resourceType: 'workspace_export',
          resourceId: jobId,
          tenantId: job.tenantId,
          workspaceId: job.workspaceId,
          payload: { error: message },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async getJob(workspaceId: string, jobId: string, userId: string): Promise<ExportJobView> {
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, ['owner', 'admin']);
    const job = await this.jobs.findOne({ where: { id: jobId, workspaceId } });
    if (!job) throw new NotFoundException('导出任务不存在');
    return this.toView(job);
  }

  /** 生成一次性下载链接（15 分钟有效）。 */
  async createDownloadLink(
    workspaceId: string,
    jobId: string,
    userId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('导出任务不存在');
    const jobWorkspace = jobWorkspaceId(job);
    if (jobWorkspace) {
      // 工作区还在：按目标工作区的角色判定（与请求导出时一致）
      if (jobWorkspace !== workspaceId) throw new NotFoundException('导出任务不存在');
      await this.workspaces.requireWorkspaceRole(workspaceId, userId, ['owner', 'admin']);
    } else {
      // 工作区已被永久清除：只能由**原始申请人本人**在产物有效期内取回，
      // 这样"关停前先导出、事后补下载"这个真实场景才成立（见 DESIGN-多租户生命周期.md §1.2）。
      if (!job.requestedBy || job.requestedBy !== userId) {
        throw new ForbiddenException('该导出产物属于一个已被永久清除的工作区，只有原申请人可以取回');
      }
      // 审计一律记"操作者当前所在工作区"（与工作区生命周期审计的口径一致）；
      // 目标工作区已被清除这个事实放在 payload 里，避免为此把 audit_logs.workspace_id 改成可空。
      const scope = await this.workspaceContext.current().catch(() => null);
      await this.audit
        .record({
          action: 'workspace.export.link_issued_after_purge',
          resourceType: 'workspace_export',
          resourceId: job.id,
          tenantId: job.tenantId,
          workspaceId: scope?.workspaceId ?? workspaceId,
          payload: { purgedWorkspaceId: workspaceId, requestedBy: job.requestedBy, sizeBytes: Number(job.sizeBytes ?? 0) },
        })
        .catch(() => undefined);
    }
    if (job.status !== 'completed' || !job.filePath) throw new ConflictException('导出尚未完成，暂时无法下载');
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) throw new NotFoundException('导出产物已过期');

    const exp = Math.floor(Date.now() / 1000) + WorkspaceExportService.TOKEN_TTL_SECONDS;
    const nonce = randomUUID();
    const payload = `${workspaceId}|${jobId}|${exp}|${nonce}`;
    const token = `${Buffer.from(payload, 'utf8').toString('base64url')}.${this.crypto.hmac(payload)}`;
    return {
      url: `/api/workspaces/${workspaceId}/export/${jobId}/download?token=${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /**
   * 凭令牌下载：校验签名与有效期 → **一次性**（Redis SETNX：同一令牌第二次使用即拒绝）→ 返回文件信息。
   * 令牌本身即鉴权凭据，因此该路由是公开路由（@Public），并额外写下载审计。
   */
  async resolveDownload(
    workspaceId: string,
    jobId: string,
    token: string,
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ path: string; fileName: string; sizeBytes: number; checksum: string | null }> {
    const [encoded, signature] = (token ?? '').split('.');
    if (!encoded || !signature) throw new UnauthorizedException('下载链接无效');
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!this.crypto.verifyHmac(payload, signature)) throw new UnauthorizedException('下载链接无效');

    const [tokenWorkspace, tokenJob, expRaw] = payload.split('|');
    if (tokenWorkspace !== workspaceId || tokenJob !== jobId) throw new UnauthorizedException('下载链接与导出任务不匹配');
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) throw new UnauthorizedException('下载链接已过期（有效期 15 分钟）');

    // 一次性：SETNX 成功才继续
    const remaining = Math.max(1, exp - Math.floor(Date.now() / 1000));
    const accepted = await this.redis.set(`export:token:${signature}`, '1', 'EX', remaining, 'NX').catch(() => 'OK');
    if (accepted === null) throw new UnauthorizedException('下载链接已被使用（一次性链接，请重新申请）');

    // 令牌已经把 workspaceId 与 jobId 一起做了 HMAC 绑定，这里不必再用 workspace_id 去匹配：
    // 工作区被永久清除后 job.workspace_id 会被置空，若仍按它匹配，已发出的下载链接会直接失效。
    const job = await this.jobs.findOne({ where: { id: jobId } });
    const jobWorkspace = job ? jobWorkspaceId(job) : null;
    if (!job || (jobWorkspace && jobWorkspace !== workspaceId)) throw new NotFoundException('导出产物不存在');
    if (job.status !== 'completed' || !job.filePath) throw new NotFoundException('导出产物不存在');
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) throw new NotFoundException('导出产物已过期');
    if (!existsSync(job.filePath)) throw new NotFoundException('导出文件已被清理');

    await this.audit
      .record({
        action: 'workspace.export.downloaded',
        resourceType: 'workspace_export',
        resourceId: jobId,
        tenantId: job.tenantId,
        workspaceId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        payload: { sizeBytes: Number(job.sizeBytes ?? 0), checksum: job.checksum },
      })
      .catch(() => undefined);

    const workspace = await this.dataSource.query('SELECT slug FROM workspaces WHERE id = $1', [workspaceId]);
    const slug = (workspace[0]?.slug as string) ?? 'workspace';
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return {
      path: job.filePath,
      fileName: `mediaflow-export-${slug}-${stamp}.zip`,
      sizeBytes: Number(job.sizeBytes ?? 0),
      checksum: job.checksum,
    };
  }

  /** 过期产物清理（每日任务调用）：删文件 + 标记 expired + 写审计。 */
  async pruneExpired(): Promise<{ removed: number; bytes: number }> {
    const expired = await this.jobs
      .createQueryBuilder('job')
      .where("job.status = 'completed' AND job.expiresAt IS NOT NULL AND job.expiresAt <= now()")
      .getMany();
    let removed = 0;
    let bytes = 0;
    for (const job of expired) {
      if (job.filePath && existsSync(job.filePath)) {
        try {
          bytes += statSync(job.filePath).size;
          unlinkSync(job.filePath);
        } catch (error) {
          this.logger.warn(`删除过期导出文件失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (jobWorkspaceId(job) === null) {
        // 工作区早已被永久清除：产物删掉之后这行没有任何用途（归谁、给谁看都无从谈起），直接删行；
        // 留痕由审计 workspace.export.expired 与 purge 账本承担。
        await this.jobs.delete({ id: job.id });
      } else {
        await this.jobs.update({ id: job.id }, { status: 'expired' });
      }
      await this.audit
        .record({
          action: 'workspace.export.expired',
          resourceType: 'workspace_export',
          resourceId: job.id,
          tenantId: job.tenantId,
          workspaceId: job.workspaceId,
          payload: { sizeBytes: Number(job.sizeBytes ?? 0), expiresAt: job.expiresAt?.toISOString() ?? null },
        })
        .catch(() => undefined);
      removed += 1;
    }
    if (removed > 0) this.logger.log(`已清理 ${removed} 个过期导出产物（释放 ${(bytes / 1024 / 1024).toFixed(1)}MB）`);
    return { removed, bytes };
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
    return hash.digest('hex');
  }
}
