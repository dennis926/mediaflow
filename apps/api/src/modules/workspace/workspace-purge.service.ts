import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rename, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { DataSource, In, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { AuthSessionService } from '../auth/auth-session.service';
import { NotificationChannelService } from '../notification/notification-channel.service';
import { runtime } from '../settings/runtime-config';
import { WorkspaceExportJob } from './entities/workspace-export-job.entity';
import { WorkspacePurgeBatch } from './entities/workspace-purge-batch.entity';
import { WorkspaceService } from './workspace.service';
import { SettingsService } from '../settings/settings.service';

export interface PurgeResult {
  purgeBatchId: string;
  workspace: { id: string; name: string; slug: string };
  deletedRows: Record<string, number>;
  deletedFiles: number;
  socialAccountsDestroyed: number;
  /**
   * 被**保留**（不是删除）的导出任务数：工作区被清除后这些任务行仍存在、workspace_id 被外键置空，
   * 产物在 7 天有效期内仍可下载（见 §1.2 与实体注释）。
   */
  retainedExportJobs: number;
  backup: { path: string; sha256: string; sizeBytes: number; expiresAt: string };
  ledgerRetained: string[];
}

/**
 * A 类：工作区私有业务数据 —— 硬删时按"子表先删"的顺序清理（同事务）。
 *
 * 2026-10-01 补漏（浏览器走查发现）：`system_settings` / `roles` / `quotas` 原先既不在
 * 删除清单、也不在备份清单，属于"两边都不在"——purge 之后它们在库里留下指向已删工作区的
 * 孤儿行（实测：18 条 system_settings、1 条 quotas）。这几张表恰好都**没有指向 workspaces
 * 的外键**，所以数据库不会拦、第 7 项监控也看不见，只有人工看界面（站点名显示成上一个
 * 工作区的配置）才会暴露。判断某张表该不该进这份清单的方法：**它是否带 workspace_id
 * 且语义上属于工作区**——是，就必须在这里（或明确写进 LEDGER_TABLES 说明为什么保留）。
 */
export const BUSINESS_TABLES: string[] = [
  'track_events',
  'analytics',
  'publish_tasks',
  'content_reviews',
  'content_revisions',
  'content_variants',
  'contents',
  'media_assets',
  'brand_knowledge',
  'content_templates',
  'social_accounts',
  'platforms',
  'notifications',
  'workspace_members',
  // 工作区级配置（站点名、AI Key、通知渠道等）—— 不删会让下一个工作区"继承"别人的配置
  'system_settings',
  // 角色是按工作区各存一份（user_roles.roles_id 指向它，CASCADE 随角色删除而清）
  'roles',
  // 用量配额（发布次数、AI token 等）按工作区+周期记账
  'quotas',
];

/**
 * 备份（= 将来恢复）用的表顺序：**父表在前**。
 *
 * 为什么不能直接复用删除顺序：删除要"子表先删"（否则外键挡着），
 * 而恢复要"父表先插"（否则 `content_variants.content_id` 找不到对应 `contents`，整包回滚）。
 * 这两件事的顺序**正好相反**——2026-09-21 的 purge 演练就是因此恢复出 0 行，故拆成两份清单。
 */
export const BACKUP_TABLES: string[] = [
  'workspaces',
  // 工作区级配置必须在备份里：否则"关停前导出、日后恢复"会丢掉站点名/AI Key/通知渠道
  'system_settings',
  'roles',
  'quotas',
  'contents',
  'content_variants',
  'content_revisions',
  'content_reviews',
  'publish_tasks',
  'analytics',
  'track_events',
  'media_assets',
  'brand_knowledge',
  'content_templates',
  'social_accounts',
  'platforms',
  'notifications',
  'workspace_members',
  'workspace_export_jobs',
];

/** B 类：成本 / 审计账本 —— 永久保留，purge 时**不删不改**。 */
export const LEDGER_TABLES: string[] = [
  'audit_logs',
  'ai_generations',
  'workspace_purge_batches',
  // 计费相关表（B0.7 新增后同样保留）
  'usage_records',
  'invoices',
  'subscriptions',
];

/**
 * 工作区永久清除（B0.4 第 4 步）。
 *
 * 铁律（用户要求）：
 *   1. **备份失败即中止**（先备份、后删除；备份不成功绝不删任何数据）
 *   2. 单事务删除，业务数据全清；审计/成本账本永久保留
 *   3. 全过程留痕：`workspace_purge_batches` 账本 + 多条审计
 *   4. 独立备份保留 180 天（配置），命名含 sha256 前 12 位
 *   5. 备份与数据库同机属已知技术债（见 docs/TECHDEBT-purge备份异地.md）
 */
@Injectable()
export class WorkspacePurgeService {
  private readonly logger = new Logger(WorkspacePurgeService.name);
  private static readonly CONFIRM_TEXT = '永久删除';
  /**
   * 清除前备份的根目录。默认 `/www/backup/mediaflow/purge`，可用环境变量 `PURGE_BACKUP_ROOT` 覆盖
   * （演练时指向临时目录；将来接入异地存储时也在这里切换）。
   */
  private backupRoot(): string {
    return this.config.get<string>('PURGE_BACKUP_ROOT') ?? '/www/backup/mediaflow/purge';
  }

  constructor(
    @InjectRepository(WorkspacePurgeBatch) private readonly batches: Repository<WorkspacePurgeBatch>,
    @InjectRepository(WorkspaceExportJob) private readonly exportJobs: Repository<WorkspaceExportJob>,
    private readonly dataSource: DataSource,
    private readonly workspaces: WorkspaceService,
    private readonly audit: AuditService,
    private readonly channels: NotificationChannelService,
    private readonly sessions: AuthSessionService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 永久清除某个工作区。仅 owner 可调用；要求已软删且保留期已过；
   * 二次确认（工作区名称 + 固定串）；**备份成功才继续**。
   */
  async purgeWorkspace(
    workspaceId: string,
    userId: string,
    dto: { confirmName: string; confirmText: string; reason?: string },
    actor: { id?: string | null; name?: string | null },
  ): Promise<PurgeResult> {
    const { workspace } = await this.workspaces.requireWorkspaceRole(workspaceId, userId, ['owner']);

    if (workspace.status !== 'soft_deleted') {
      throw new ConflictException('该工作区尚未删除，不能永久清除（请先删除并等保留期结束）');
    }
    const deadline = workspace.purgeAfter ?? workspace.deletedAt;
    if (!deadline || Date.now() < deadline.getTime()) {
      const days = deadline ? Math.max(1, Math.ceil((deadline.getTime() - Date.now()) / 86400000)) : 0;
      throw new ConflictException(`保留期未结束（还有约 ${days} 天），到期后才能永久清除`);
    }
    if (dto.confirmName?.trim() !== workspace.name) {
      throw new BadRequestException('工作区名称不匹配：请输入完整名称以确认永久清除');
    }
    if (dto.confirmText?.trim() !== WorkspacePurgeService.CONFIRM_TEXT) {
      throw new BadRequestException(`二次确认不正确：请输入「${WorkspacePurgeService.CONFIRM_TEXT}」`);
    }
    const runningExports = await this.exportJobs.count({ where: { workspaceId, status: In(['queued', 'running'] as never[]) } });
    if (runningExports > 0) throw new ConflictException('该工作区有正在进行的导出任务，请等待其完成');

    const batch = await this.batches.save(
      this.batches.create({
        workspaceId,
        tenantId: workspace.tenantId,
        workspaceName: workspace.name,
        workspaceSlug: workspace.slug,
        status: 'started',
        reason: dto.reason ?? null,
        requestedBy: actor.id ?? null,
        requestedByName: actor.name ?? null,
        ledgerRetained: LEDGER_TABLES,
        deletedRows: {},
        failures: [],
      }),
    );

    await this.audit
      .record({
        action: 'workspace.purge_started',
        resourceType: 'workspace',
        resourceId: workspaceId,
        tenantId: workspace.tenantId,
        workspaceId,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        payload: { batchId: batch.id, workspaceName: workspace.name, reason: dto.reason ?? null },
      })
      .catch(() => undefined);

    let backup: { path: string; sha256: string; sizeBytes: number };
    try {
      // ① 备份（失败即中止：不允许"先删后备份"）
      backup = await this.backupWorkspace(workspace.id, workspace.slug);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.batches.update({ id: batch.id }, { status: 'failed', errorMessage: `备份失败：${message}` });
      await this.audit
        .record({
          action: 'workspace.purge_failed',
          resourceType: 'workspace',
          resourceId: workspaceId,
          tenantId: workspace.tenantId,
          workspaceId,
          payload: { batchId: batch.id, stage: 'backup', error: message },
        })
        .catch(() => undefined);
      this.logger.error(`永久清除已中止（备份失败，未删除任何数据）：${workspace.name}｜${message}`);
      throw new ServiceUnavailableException(`清除前备份失败，已中止（未删除任何数据）：${message}`);
    }

    try {
      // ② 删除文件（先文件后行；失败不阻断，记入 failures）
      const { deletedFiles, failures } = await this.deleteFiles(workspace.id);
      // ③ 单事务删除业务数据 + 工作区自身
      const { deletedRows, socialAccountsDestroyed, retainedExportJobs } = await this.deleteRows(workspace.id);

      const backupExpiresAt = new Date(
        Date.now() + runtime().workspace.purgeBackupRetentionDays * 24 * 60 * 60 * 1000,
      );
      await this.batches.update(
        { id: batch.id },
        {
          status: failures.length > 0 ? 'completed' : 'completed',
          deletedRows,
          deletedFiles,
          failures,
          socialAccountsDestroyed,
          retainedExportJobs,
          backupPath: backup.path,
          backupSha256: backup.sha256,
          backupExpiresAt,
        },
      );

      await this.sessions.invalidateWorkspace(workspaceId);
      // B0.5：同时丢弃该工作区的运行时配置快照，避免内存里长期留着已清除租户的配置
      this.settings.forgetWorkspace(workspaceId);
      // B0.6：若这条清除对应一次合规删除请求，标记请求完成并关联账本
      await this.workspaces.completeDeletionRequest(workspaceId, batch.id);
      await this.audit
        .record({
          action: 'workspace.purge_completed',
          resourceType: 'workspace',
          resourceId: workspaceId,
          tenantId: workspace.tenantId,
          workspaceId,
          actorId: actor.id ?? null,
          actorName: actor.name ?? null,
          payload: { batchId: batch.id, deletedRows, deletedFiles, retainedExportJobs, backupSha256: backup.sha256, ledgerRetained: LEDGER_TABLES },
        })
        .catch(() => undefined);
      const destroyed = deletedRows.social_accounts ?? 0;
      if (destroyed > 0) {
        await this.audit
          .record({
            action: 'workspace.purge.social_accounts_destroyed',
            resourceType: 'workspace',
            resourceId: workspaceId,
            tenantId: workspace.tenantId,
            workspaceId,
            payload: { batchId: batch.id, count: destroyed, note: '平台账号密文已随行删除' },
          })
          .catch(() => undefined);
      }
      /**
       * 只走**外部渠道**（邮件/群机器人）通报，刻意不写站内通知：
       * 站内通知属于 A 类业务数据，而这条通知的产生时刻工作区已经不存在——
       * 写下去会落进一个刚被清除的工作区里（实测导致"A 类表清空后仍残留 1 条通知"）。
       * 责任人留痕由审计 + purge 账本承担。
       */
      if (this.channels.available().length > 0) {
        const summary = {
          title: `工作区「${workspace.name}」已永久清除`,
          text:
            `操作人：${actor.name ?? actor.id ?? '未知'}；删除业务行合计 ${Object.values(deletedRows).reduce((sum, n) => sum + n, 0)} 条、文件 ${deletedFiles} 个；` +
            `审计与成本流水已保留；导出任务 ${retainedExportJobs} 个被保留（产物仍可在有效期内下载）。` +
            `清除前备份：${backup.path}（保留 ${runtime().workspace.purgeBackupRetentionDays} 天，sha256 ${backup.sha256.slice(0, 12)}…）。`,
          context: { batchId: batch.id, deletedRows, retainedExportJobs, backupSha256: backup.sha256 },
        };
        await this.channels.dispatch(summary).catch((error: unknown) => {
          this.logger.warn(`清除完成通报发送失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }

      this.logger.warn(
        `工作区已永久清除：${workspace.name}（业务行 ${Object.values(deletedRows).reduce((sum, n) => sum + n, 0)} 条 / 文件 ${deletedFiles} 个）`,
      );
      return {
        purgeBatchId: batch.id,
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        deletedRows,
        deletedFiles,
        socialAccountsDestroyed: destroyed,
        retainedExportJobs,
        backup: { ...backup, expiresAt: backupExpiresAt.toISOString() },
        ledgerRetained: LEDGER_TABLES,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.batches.update({ id: batch.id }, { status: 'failed', errorMessage: message });
      await this.audit
        .record({
          action: 'workspace.purge_failed',
          resourceType: 'workspace',
          resourceId: workspaceId,
          tenantId: workspace.tenantId,
          workspaceId,
          payload: { batchId: batch.id, stage: 'delete', error: message },
        })
        .catch(() => undefined);
      this.logger.error(`永久清除失败：${workspace.name}｜${message}`);
      throw error;
    }
  }

  /** 到期的（软删满保留期）工作区自动清除，供每日任务调用。 */
  async purgeExpiredWorkspaces(): Promise<{ purged: number; failed: number; results: Array<{ id: string; name: string }> }> {
    const due = await this.dataSource.query(
      "SELECT id, name FROM workspaces WHERE status = 'soft_deleted' AND purge_after IS NOT NULL AND purge_after <= now() ORDER BY purge_after ASC",
    );
    const results: Array<{ id: string; name: string }> = [];
    let failed = 0;
    for (const row of due as Array<{ id: string; name: string }>) {
      try {
        const owner = await this.dataSource.query(
          "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role_codes::text LIKE '%owner%' LIMIT 1",
          [row.id],
        );
        const ownerId = (owner[0]?.user_id as string) ?? null;
        if (!ownerId) {
          this.logger.warn(`到期工作区没有 owner，跳过自动清除（需人工介入）：${row.name}`);
          failed += 1;
          continue;
        }
        const workspace = await this.dataSource.query('SELECT name FROM workspaces WHERE id = $1', [row.id]);
        await this.purgeWorkspace(
          row.id,
          ownerId,
          { confirmName: workspace[0]?.name ?? row.name, confirmText: WorkspacePurgeService.CONFIRM_TEXT, reason: '保留期到期，定时任务自动清除' },
          { id: null, name: '系统定时任务' },
        );
        results.push({ id: row.id, name: row.name });
      } catch (error) {
        failed += 1;
        this.logger.warn(`自动清除失败：${row.name}｜${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { purged: results.length, failed, results };
  }

  /**
   * 清除前独立备份：`pg_dump --data-only --where="workspace_id='…'"` 逐表导出 + gzip，
   * 命名含 sha256 前 12 位，权限 600；**任一步失败都抛错**（调用方据此中止 purge）。
   */
  async backupWorkspace(workspaceId: string, slug: string): Promise<{ path: string; sha256: string; sizeBytes: number }> {
    const dir = join(this.backupRoot(), workspaceId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const tempPath = join(dir, `.tmp-${stamp}.sql.gz`);
    const tables = BACKUP_TABLES;

    const host = this.config.get<string>('DB_HOST') ?? '127.0.0.1';
    const port = this.config.get<string>('DB_PORT') ?? '5432';
    const user = this.config.get<string>('DB_USER') ?? 'mediaflow';
    const database = this.config.get<string>('DB_NAME') ?? 'mediaflow';
    const password = this.config.get<string>('DB_PASSWORD') ?? '';

    const write = createWriteStream(tempPath, { mode: 0o600 });
    const gzip = createGzip({ level: 6 });
    gzip.pipe(write);
    const writeAsync = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (gzip.write(chunk)) resolve();
        else gzip.once('drain', () => resolve());
        gzip.once('error', reject);
      });
    const finishWrite = (): Promise<void> =>
      new Promise((resolve, reject) => {
        write.on('close', () => resolve());
        write.on('error', reject);
        gzip.end();
      });

    try {
      await writeAsync(
        [
          '-- MediaFlow 工作区清除前备份',
          `-- 工作区：${slug}（${workspaceId}）`,
          `-- 导出时间：${new Date().toISOString()}`,
          '-- 恢复方式：gunzip 后 psql -f 本文件（内含 COPY ... FROM STDIN 块，可直接重放）',
          '-- 说明：仅包含工作区私有业务数据与工作区自身行；审计与成本账本不在此备份中（它们不会被清除）。',
          '',
          'BEGIN;',
          '',
        ].join('\n'),
      );

      let tablesDumped = 0;
      let rowsDumped = 0;
      for (const table of tables) {
        const columns: Array<{ column_name: string }> = await this.dataSource.query(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
          ['public', table],
        );
        if (columns.length === 0) continue;
        const columnList = columns.map((column) => `"${column.column_name}"`).join(', ');
        const copyOut = `COPY (SELECT ${columnList} FROM "${table}" WHERE workspace_id = '${workspaceId}') TO STDOUT WITH CSV HEADER`;

        const csv = await new Promise<string>((resolve, reject) => {
          const child = spawn('psql', ['-X', '-q', '-A', '-h', host, '-p', String(port), '-U', user, '-d', database, '-c', copyOut], {
            env: { ...process.env, PGPASSWORD: password },
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(`导出 ${table} 失败（退出码 ${code}）：${stderr.trim().slice(0, 300)}`));
            else resolve(stdout);
          });
        });

        const dataLines = csv.trimEnd() === '' ? 0 : csv.trimEnd().split('\n').length - 1; // 减去表头
        rowsDumped += dataLines;
        if (dataLines === 0) continue; // 空表跳过，备份更紧凑
        tablesDumped += 1;
        await writeAsync(`-- 表 ${table}：${dataLines} 行\nCOPY "${table}" (${columnList}) FROM STDIN WITH CSV HEADER;\n${csv.endsWith('\n') ? csv : `${csv}\n`}\\.\n\n`);
      }

      await writeAsync(['COMMIT;', '', `-- 共 ${tablesDumped} 张表 / ${rowsDumped} 行`, ''].join('\n'));
      await finishWrite();

      const sizeBytes = statSync(tempPath).size;
      if (sizeBytes < 100) throw new Error(`备份文件过小（${sizeBytes} 字节），疑似导出为空`);
      if (rowsDumped === 0) throw new Error('备份为空（该工作区没有任何待删除数据）');

      const sha256 = await this.hashFile(tempPath);
      const finalPath = join(dir, `${slug}-${stamp}-${sha256.slice(0, 12)}.sql.gz`);
      await new Promise<void>((resolve, reject) => {
        rename(tempPath, finalPath, (error) => (error ? reject(error) : resolve()));
      });
      this.logger.log(`清除前备份完成：${finalPath}（${tablesDumped} 张表 / ${rowsDumped} 行，${(sizeBytes / 1024).toFixed(1)}KB，sha256 ${sha256.slice(0, 12)}…）`);
      return { path: finalPath, sha256, sizeBytes };
    } catch (error) {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // 忽略
        }
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 删除工作区文件（素材 + 知识库留档）；单个失败不阻断，返回失败清单。 */
  async deleteFiles(workspaceId: string): Promise<{ deletedFiles: number; failures: Array<{ path: string; error: string }> }> {
    const mediaDir = join(process.cwd(), '../../uploads/media');
    const knowledgeDir = join(process.cwd(), '../../uploads/knowledge');
    const targets: string[] = [];

    const media = await this.dataSource.query('SELECT stored_name FROM media_assets WHERE workspace_id = $1', [workspaceId]);
    for (const row of media as Array<{ stored_name: string }>) {
      if (row.stored_name) targets.push(join(mediaDir, basename(row.stored_name)));
    }
    const knowledge = await this.dataSource.query(
      'SELECT source_url FROM brand_knowledge WHERE workspace_id = $1 AND source_url IS NOT NULL',
      [workspaceId],
    );
    for (const row of knowledge as Array<{ source_url: string }>) {
      if (row.source_url) targets.push(join(knowledgeDir, basename(row.source_url)));
    }

    let deletedFiles = 0;
    const failures: Array<{ path: string; error: string }> = [];
    for (const path of targets) {
      // 目录穿越防护：只允许 uploads 下的文件
      if (!path.includes('/uploads/')) {
        failures.push({ path, error: '路径不在 uploads 目录内，已跳过' });
        continue;
      }
      try {
        if (existsSync(path)) {
          unlinkSync(path);
          deletedFiles += 1;
        }
      } catch (error) {
        failures.push({ path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { deletedFiles, failures };
  }

  /** 单事务删除业务数据（先子表后主表），最后删工作区自身；返回逐表行数与销毁的账号数。 */
  async deleteRows(
    workspaceId: string,
  ): Promise<{ deletedRows: Record<string, number>; socialAccountsDestroyed: number; retainedExportJobs: number }> {
    const deletedRows: Record<string, number> = {};
    let exportCount = 0;
    await this.dataSource.transaction(async (manager) => {
      for (const table of BUSINESS_TABLES) {
        const before = await manager.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
        const count = Number(before[0]?.n ?? 0);
        if (count > 0) await manager.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
        deletedRows[table] = count;
      }
      // 导出任务行**刻意不删**：workspace_export_jobs.workspace_id 是 ON DELETE SET NULL（B0.4 第 5 步），
      // 删工作区行时它会被置空，任务与产物留在原地——这样"关停前先导出、事后仍能下载"才成立（第 1 步的设计意图）。
      const exportRows = await manager.query('SELECT count(*)::int AS n FROM workspace_export_jobs WHERE workspace_id = $1', [workspaceId]);
      exportCount = Number(exportRows[0]?.n ?? 0);
      deletedRows.workspace_export_jobs = 0;
      await manager.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    });
    return { deletedRows, socialAccountsDestroyed: deletedRows.social_accounts ?? 0, retainedExportJobs: exportCount };
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      createReadStream(path)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve())
        .on('error', reject);
    });
    return hash.digest('hex');
  }

  /** 清理超过保留期的 purge 备份（180 天后），删除前写审计。 */
  async pruneBackups(): Promise<{ removed: number; bytes: number }> {
    const expired: WorkspacePurgeBatch[] = await this.batches
      .createQueryBuilder('batch')
      .where("batch.backupPath IS NOT NULL AND batch.backupExpiresAt IS NOT NULL AND batch.backupExpiresAt <= now()")
      .getMany();
    let removed = 0;
    let bytes = 0;
    for (const batch of expired) {
      const path = batch.backupPath as string;
      try {
        if (existsSync(path)) {
          bytes += statSync(path).size;
          unlinkSync(path);
        }
        await this.batches.update({ id: batch.id }, { backupPath: null });
        await this.audit
          .record({
            action: 'workspace.purge_backup_expired',
            resourceType: 'workspace_purge_batch',
            resourceId: batch.id,
            tenantId: batch.tenantId,
            workspaceId: batch.workspaceId,
            payload: { path, sha256: batch.backupSha256, reason: '超过备份保留期' },
          })
          .catch(() => undefined);
        removed += 1;
      } catch (error) {
        this.logger.warn(`清理 purge 备份失败：${path}｜${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (removed > 0) this.logger.log(`已清理 ${removed} 个过期 purge 备份（释放 ${(bytes / 1024 / 1024).toFixed(1)}MB）`);
    return { removed, bytes };
  }

  /** 供演练/运维查询：某个工作区在 purge 前的预估影响面。 */
  async preview(workspaceId: string, userId: string): Promise<{ rows: Record<string, number>; files: number }> {
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, ['owner']);
    const rows: Record<string, number> = {};
    for (const table of BUSINESS_TABLES) {
      const result = await this.dataSource.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
      rows[table] = Number(result[0]?.n ?? 0);
    }
    const media = await this.dataSource.query('SELECT count(*)::int AS n FROM media_assets WHERE workspace_id = $1', [workspaceId]);
    return { rows, files: Number(media[0]?.n ?? 0) };
  }
}
