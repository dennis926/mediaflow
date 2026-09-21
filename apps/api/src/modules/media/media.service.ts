import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { IsNull, Like, Repository } from 'typeorm';
import { QuotaService } from '../billing/quota.service';
import { AuditService } from '../../audit/audit.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { runtime } from '../settings/runtime-config';
import { MediaAsset, MediaKind } from './entities/media-asset.entity';

export interface MediaActor {
  id?: string | null;
  name?: string | null;
}

export interface MediaPage {
  items: MediaAsset[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * 按文件头（magic bytes）判断真实类型。
 * 只信客户端声明的 Content-Type 是不安全的（改个后缀/声明就能绕过白名单）。
 */
export function detectMimeType(buffer: Buffer): string | null {
  const ascii = (start: number, length: number): string => buffer.subarray(start, start + length).toString('latin1');
  if (buffer.length >= 8 && buffer[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (buffer.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm';
  if (buffer.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buffer.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  return null;
}

/** 允许的上传类型：可配置（设置 → 素材库），默认覆盖常见图片与视频。 */
export const DEFAULT_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
];

/**
 * 只读取文件头若干字节用于魔数判断 —— 大文件不必整块读进内存。
 */
export function readHead(path: string, bytes = 32): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, Math.max(read, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * 原子移动：优先 rename（同分区是原子操作）；跨分区（EXDEV）退化为 copyFile + unlink。
 */
export function moveAtomic(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  copyFileSync(from, to);
  unlinkSync(from);
}

/** 尽力删除临时/残留文件（失败只记日志，不影响主流程）。 */
function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function kindOf(mimeType: string): MediaKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectRepository(MediaAsset) private readonly assets: Repository<MediaAsset>,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
  ) {}

  /** 素材目录：可用 MEDIA_STORAGE_DIR 指到挂载盘或对象存储的本地挂载点。 */
  private storageDir(): string {
    const configured = runtime().media.storageDir;
    return configured.startsWith('/') ? configured : join(process.cwd(), '../..', configured);
  }

  private publicUrl(storedName: string): string {
    const base = runtime().media.publicBaseUrl.trim().replace(/\/$/, '');
    return base ? `${base}/${storedName}` : `/api/public/media/${storedName}`;
  }

  /**
   * 是否允许该文件（类型白名单 + 单文件上限都可配置）。
   * 校验顺序：大小 → 文件头真实类型 → 白名单；声明类型与真实类型不符也拒绝。
   */
  assertAllowed(mimeType: string, size: number, buffer?: Buffer): void {
    const config = runtime().media;
    const allowed = config.allowedTypes.length > 0 ? config.allowedTypes : DEFAULT_MEDIA_TYPES;

    if (buffer && buffer.length > 0) {
      const detected = detectMimeType(buffer);
      if (!detected) {
        throw new BadRequestException('无法识别的文件内容，仅支持常见图片/视频/音频格式');
      }
      if (!allowed.includes(detected)) {
        throw new BadRequestException(`不支持的文件类型 ${detected}，允许：${allowed.join('、')}（可在「设置 → 素材库」调整）`);
      }
      if (mimeType && mimeType !== detected && !allowed.includes(mimeType)) {
        throw new BadRequestException(`文件内容与声明的类型不符（声明 ${mimeType}，实际 ${detected}）`);
      }
      if (mimeType && mimeType !== detected) {
        // 声明的类型合法但和真实内容不一致：以真实内容为准，避免"改名绕过"
        throw new BadRequestException(`文件内容与声明的类型不符（声明 ${mimeType}，实际 ${detected}）`);
      }
    }

    if (!allowed.includes(mimeType)) {
      throw new BadRequestException(`不支持的文件类型 ${mimeType || '(未知)'}，允许：${allowed.join('、')}（可在「设置 → 素材库」调整）`);
    }
    const limit = config.maxFileMb * 1024 * 1024;
    if (size > limit) {
      throw new BadRequestException(`文件过大（${(size / 1024 / 1024).toFixed(1)}MB），上限 ${config.maxFileMb}MB（可在「设置 → 素材库」调整）`);
    }
    if (size === 0) throw new BadRequestException('文件内容为空');
  }

  /**
   * 从磁盘临时文件完成上传（任务 4 / 审计 P2-3 的主路径）。
   *
   * 流程：读文件头做魔数+白名单+大小校验 → 原子移动到最终目录 → 落库。
   * 任何一步失败都会删掉临时文件（校验失败）或最终文件（落库失败），不留垃圾。
   */
  async uploadFromTemp(
    file: { path: string; originalname: string; mimetype: string; size: number },
    actor: MediaActor,
    groupName?: string,
  ): Promise<MediaAsset> {
    const scope = await this.workspaceContext.current();
    const dir = this.storageDir();
    const extension = extname(file.originalname).slice(0, 12) || '';
    const storedName = `${randomUUID()}${extension}`;
    const destination = join(dir, storedName);
    let moved = false;

    try {
      // 只读文件头就能判断真实类型，避免大文件进内存
      const head = readHead(file.path, 32);
      this.assertAllowed(file.mimetype, file.size, head);
      const detected = detectMimeType(head) ?? file.mimetype;

      mkdirSync(dir, { recursive: true });
      moveAtomic(file.path, destination);
      moved = true;

      const saved = await this.assets.save(
        this.assets.create({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          storedName,
          originalName: file.originalname,
          // 以文件头识别出的真实类型入库（不信任客户端声明）
          mimeType: detected,
          kind: kindOf(detected),
          size: String(file.size),
          url: this.publicUrl(storedName),
          uploadedBy: actor.id ?? null,
          uploadedByName: actor.name ?? null,
          groupName: groupName?.trim() ? groupName.trim() : null,
          deletedAt: null,
        }),
      );

      await this.audit.record({
        action: 'media.upload',
        resourceType: 'media_asset',
        resourceId: saved.id,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        payload: { originalName: file.originalname, mimeType: detected, declaredType: file.mimetype, size: file.size, mode: 'disk' },
      });
      await this.quota.recordUsage('upload_mb', Math.round((file.size / (1024 * 1024)) * 100) / 100, {
        sourceType: 'media_asset',
        sourceId: saved.id,
      });
      this.logger.log(`素材已上传（磁盘暂存）：${file.originalname}（${(file.size / 1024).toFixed(0)}KB）`);
      return saved;
    } catch (error) {
      // 校验失败：删临时文件；移动成功但落库失败：连最终文件一起清掉
      safeUnlink(file.path);
      if (moved) safeUnlink(destination);
      throw error;
    }
  }

  async upload(
    file: { originalname: string; buffer: Buffer; size: number; mimetype: string },
    actor: MediaActor,
    groupName?: string,
  ): Promise<MediaAsset> {
    this.assertAllowed(file.mimetype, file.size, file.buffer);
    // B0.7：素材存储配额（瞬时口径：按当前总占用计算）
    const megabytes = Math.round((file.size / (1024 * 1024)) * 100) / 100;
    await this.quota.assertQuota('upload_mb', megabytes);
    const scope = await this.workspaceContext.current();
    const dir = this.storageDir();
    mkdirSync(dir, { recursive: true });

    const extension = extname(file.originalname).slice(0, 12) || '';
    const storedName = `${randomUUID()}${extension}`;
    writeFileSync(join(dir, storedName), file.buffer);

    const saved = await this.assets.save(
      this.assets.create({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        storedName,
        originalName: file.originalname,
        mimeType: file.mimetype,
        kind: kindOf(file.mimetype),
        size: String(file.size),
        url: this.publicUrl(storedName),
        uploadedBy: actor.id ?? null,
        uploadedByName: actor.name ?? null,
        groupName: groupName?.trim() ? groupName.trim() : null,
        deletedAt: null,
      }),
    );

    await this.audit.record({
      action: 'media.upload',
      resourceType: 'media_asset',
      resourceId: saved.id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { originalName: file.originalname, mimeType: file.mimetype, size: file.size },
    });
    this.logger.log(`素材已上传：${file.originalname}（${(file.size / 1024).toFixed(0)}KB）`);
    return saved;
  }

  async list(query: { kind?: string; keyword?: string; group?: string; page?: number; pageSize?: number }): Promise<MediaPage> {
    const scope = await this.workspaceContext.current();
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 24;

    const builder = this.assets
      .createQueryBuilder('media')
      .where('media.workspaceId = :workspaceId AND media.deletedAt IS NULL', { workspaceId: scope.workspaceId });
    if (query.kind) builder.andWhere('media.kind = :kind', { kind: query.kind });
    if (query.group) builder.andWhere('media.groupName = :group', { group: query.group });
    if (query.keyword) builder.andWhere('media.originalName ILIKE :kw', { kw: `%${query.keyword}%` });

    const [items, total] = await builder
      .orderBy('media.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } };
  }

  /** 素材分组名（用于按项目归类筛选）。 */
  async groups(): Promise<Array<{ group: string; count: number }>> {
    const scope = await this.workspaceContext.current();
    const rows = await this.assets
      .createQueryBuilder('media')
      .select('media.groupName', 'group')
      .addSelect('COUNT(*)', 'count')
      .where('media.workspaceId = :workspaceId AND media.deletedAt IS NULL AND media.groupName IS NOT NULL', {
        workspaceId: scope.workspaceId,
      })
      .groupBy('media.groupName')
      .orderBy('count', 'DESC')
      .limit(50)
      .getRawMany<{ group: string; count: string }>();
    return rows.map((row) => ({ group: row.group, count: Number(row.count) }));
  }

  async get(id: string): Promise<MediaAsset> {
    const scope = await this.workspaceContext.current();
    const asset = await this.assets.findOne({ where: { id, workspaceId: scope.workspaceId } });
    if (!asset || asset.deletedAt) throw new NotFoundException('素材不存在或已删除');
    return asset;
  }

  /** 软删除 + 从磁盘移除；已被内容引用的素材会提示但仍允许删除（URL 失效由用户决定）。 */
  async remove(id: string, actor: MediaActor): Promise<{ id: string }> {
    const asset = await this.get(id);
    const scope = await this.workspaceContext.current();
    await this.assets.update({ id: asset.id }, { deletedAt: new Date() });
    try {
      const path = join(this.storageDir(), asset.storedName);
      if (existsSync(path)) rmSync(path, { force: true });
    } catch (error) {
      this.logger.warn(`删除素材文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
    await this.audit.record({
      action: 'media.delete',
      resourceType: 'media_asset',
      resourceId: asset.id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      payload: { originalName: asset.originalName },
    });
    return { id: asset.id };
  }

  /**
   * 读取磁盘文件用于对外访问。
   *
   * 注意两点：
   * 1. 文件名必须是"uuid + 扩展名"形态，避免路径穿越；
   * 2. Content-Type 必须是**真实类型**——早期统一返回 application/octet-stream，
   *    浏览器在 <img> 里可能直接当成下载而不是显示图片。
   */
  async openFile(storedName: string): Promise<{ stream: Readable; contentType: string; size: number } | null> {
    if (!/^[a-f0-9-]{36}(\.[A-Za-z0-9]{1,12})?$/.test(storedName)) return null;
    const path = join(this.storageDir(), storedName);
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    const asset = await this.assets.findOne({ where: { storedName } });
    return {
      stream: createReadStream(path),
      contentType: asset?.mimeType ?? MediaService.mimeFromExtension(storedName),
      size: stat.size,
    };
  }

  /** 兜底：磁盘文件存在但数据库记录缺失（例如手工拷进来的文件）时按扩展名判断。 */
  private static mimeFromExtension(fileName: string): string {
    const extension = extname(fileName).toLowerCase();
    const table: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
    };
    return table[extension] ?? 'application/octet-stream';
  }

  /** 供其他模块校验"这个 URL 是否来自本系统素材"。 */
  async existsByUrl(url: string): Promise<boolean> {
    const scope = await this.workspaceContext.current();
    const found = await this.assets.findOne({ where: { workspaceId: scope.workspaceId, url, deletedAt: IsNull() } });
    return Boolean(found);
  }

  /** 兼容查询：按原始文件名模糊匹配（编辑器里按名字找素材）。 */
  async searchByName(keyword: string, limit = 20): Promise<MediaAsset[]> {
    const scope = await this.workspaceContext.current();
    return this.assets.find({
      where: { workspaceId: scope.workspaceId, originalName: Like(`%${keyword}%`), deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
