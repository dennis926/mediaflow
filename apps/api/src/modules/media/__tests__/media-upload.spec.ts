import type { QuotaService } from '../../billing/quota.service';
import { BadRequestException, HttpException } from '@nestjs/common';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectLiteral, Repository } from 'typeorm';
import { describe, expect, it, vi, afterEach } from 'vitest';
import Redis from 'ioredis';
import { AuditService } from '../../../audit/audit.service';
import { WorkspaceContextService } from '../../../common/workspace-context.service';
import { applyRuntimeConfig } from '../../settings/runtime-config';
import { MediaAsset } from '../entities/media-asset.entity';
import { MediaService } from '../media.service';
import { MediaUploadLimiter } from '../media-upload.limiter';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const EXE = Buffer.concat([Buffer.from('4d5a90000300000004000000ffff0000', 'hex'), Buffer.from('x'.repeat(64))]);

function repo<T extends ObjectLiteral>(overrides: Partial<Record<string, unknown>> = {}): Repository<T> {
  return {
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: unknown) => ({ ...(value as object), id: 'asset-1' })),
    findOne: vi.fn(async () => null),
    update: vi.fn(async () => ({ affected: 1 })),
    ...overrides,
  } as unknown as Repository<T>;
}

function buildService(options: { saveFails?: boolean } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'mf-upload-final-'));   // 最终素材目录
  const incomingDir = mkdtempSync(join(tmpdir(), 'mf-upload-tmp-'));  // 模拟 multer 落盘的临时目录
  const assets = repo<MediaAsset>({
    save: options.saveFails
      ? vi.fn(async () => {
          throw new Error('数据库写入失败');
        })
      : vi.fn(async (value: unknown) => ({ ...(value as object), id: 'asset-1' })),
  });
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const workspaceContext = {
    current: vi.fn(async () => ({ tenantId: 't-1', workspaceId: 'w-1' })),
  } as unknown as WorkspaceContextService;
  const service = new MediaService(assets, workspaceContext, audit, quotaStub);
  applyRuntimeConfig({ MEDIA_STORAGE_DIR: workDir, MEDIA_MAX_FILE_MB: '1', MEDIA_ALLOWED_TYPES: 'image/png,image/jpeg' });
  return { service, workDir, incomingDir, assets, audit };
}

function tempFile(dir: string, name: string, content: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

afterEach(() => applyRuntimeConfig({}));

/** B0.7：配额服务替身（默认放行、记录用量） */
const quotaStub = {
  assertQuota: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => undefined),
  status: vi.fn(async () => null),
  statusAll: vi.fn(async () => []),
  effectivePlan: vi.fn(async () => ({ code: 'test', name: '测试计划' })),
} as unknown as QuotaService;

describe('素材上传：磁盘暂存 + 校验 + 原子移动（任务 4 / 审计 P2-3）', () => {
  it('合法 PNG：移动成功、临时文件消失、入库类型以文件头为准', async () => {
    const { service, workDir, incomingDir, assets } = buildService();
    const tmp = tempFile(incomingDir, 'incoming.png', PNG);

    const saved = await service.uploadFromTemp(
      { path: tmp, originalname: '图片.png', mimetype: 'image/png', size: PNG.length },
      { id: 'u-1', name: '运营' },
      '验收',
    );

    expect(saved.id).toBe('asset-1');
    expect(existsSync(tmp)).toBe(false); // 临时文件已被移走
    const created = (assets.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { mimeType: string; size: string };
    expect(created.mimeType).toBe('image/png');
    expect(created.size).toBe(String(PNG.length));
    expect(existsSync(join(workDir, (created as unknown as { storedName: string }).storedName))).toBe(true);
  });

  it('伪装文件（EXE 改名成 .png）：400 且临时文件被删除', async () => {
    const { service, incomingDir } = buildService();
    const tmp = tempFile(incomingDir, 'evil.png', EXE);

    await expect(
      service.uploadFromTemp({ path: tmp, originalname: 'evil.png', mimetype: 'image/png', size: EXE.length }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(existsSync(tmp)).toBe(false); // 失败即删，不留垃圾
  });

  it('超过单文件上限：400（multer 层会先拦成 413，这里是服务端的第二道防线）', async () => {
    const { service, incomingDir } = buildService();
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const tmp = tempFile(incomingDir, 'big.png', big);

    await expect(
      service.uploadFromTemp({ path: tmp, originalname: 'big.png', mimetype: 'image/png', size: big.length }, {}),
    ).rejects.toThrow(/上限/);

    expect(existsSync(tmp)).toBe(false);
  });

  it('落库失败：最终文件与临时文件都被清理', async () => {
    const { service, workDir, incomingDir } = buildService({ saveFails: true });
    const tmp = tempFile(incomingDir, 'ok.png', PNG);

    await expect(
      service.uploadFromTemp({ path: tmp, originalname: 'ok.png', mimetype: 'image/png', size: PNG.length }, {}),
    ).rejects.toThrow(/数据库写入失败/);

    expect(existsSync(tmp)).toBe(false);
    // 最终素材目录里不应残留"移动成功但落库失败"的文件
    expect(readdirSync(workDir)).toEqual([]);
  });
});

describe('上传并发限制（Redis 计数器）', () => {
  /** sequence 是 incr 的返回序列，用来模拟并发计数 */
  function buildLimiter(sequence: number[]): { limiter: MediaUploadLimiter; redis: Record<string, ReturnType<typeof vi.fn>> } {
    const values = [...sequence];
    const redis = {
      incr: vi.fn(async () => values.shift() ?? 1),
      decr: vi.fn(async () => 0),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 1),
      get: vi.fn(async () => '0'),
    };
    applyRuntimeConfig({ MEDIA_MAX_CONCURRENT_UPLOADS: '3', MEDIA_UPLOAD_TTL_SECONDS: '60' });
    return { limiter: new MediaUploadLimiter(redis as unknown as Redis), redis };
  }

  it('前 3 个放行，第 4 个 429（文案含当前值与上限）', async () => {
    const { limiter } = buildLimiter([1, 2, 3, 4, 4]);

    await expect(limiter.acquire('u-1')).resolves.toBeUndefined();
    await expect(limiter.acquire('u-1')).resolves.toBeUndefined();
    await expect(limiter.acquire('u-1')).resolves.toBeUndefined();

    await expect(limiter.acquire('u-1')).rejects.toBeInstanceOf(HttpException);
    // 文案必须让运维看懂：当前值与上限都在
    await expect(limiter.acquire('u-1')).rejects.toThrow(/上限 3 个/);
  });

  it('超限时立即归还计数，避免把后续请求一起挡住', async () => {
    const { limiter, redis } = buildLimiter([4]);
    await expect(limiter.acquire('u-1')).rejects.toBeInstanceOf(HttpException);
    expect(redis.decr).toHaveBeenCalledTimes(1);
  });

  it('首次占用时设置 60 秒 TTL（进程被杀也能自动解锁）', async () => {
    const { limiter, redis } = buildLimiter([1]);
    await limiter.acquire('u-1');
    expect(redis.expire).toHaveBeenCalledWith('upload:concurrent:u-1', 60);
  });

  it('release 递减并在归零时删除 key', async () => {
    const { limiter, redis } = buildLimiter([1]);
    redis.decr.mockResolvedValueOnce(0);
    await limiter.release('u-1');
    expect(redis.decr).toHaveBeenCalledWith('upload:concurrent:u-1');
    expect(redis.del).toHaveBeenCalledWith('upload:concurrent:u-1');
  });

  it('Redis 故障时降级放行（不因缓存故障阻塞业务）', async () => {
    const { limiter, redis } = buildLimiter([1]);
    redis.incr.mockRejectedValueOnce(new Error('redis down'));
    await expect(limiter.acquire('u-1')).resolves.toBeUndefined();
  });
});
