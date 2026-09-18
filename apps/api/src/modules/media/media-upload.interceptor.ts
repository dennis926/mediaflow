import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { AuthUser } from '../auth/auth.types';
import { runtime } from '../settings/runtime-config';
import { MediaUploadLimiter } from './media-upload.limiter';

/** 临时目录：默认系统临时目录下的 mediaflow-upload（权限 0700），可用 MEDIA_TMP_DIR 指定。 */
export function mediaTempDir(): string {
  const configured = runtime().media.tmpDir.trim();
  return configured || join(tmpdir(), 'mediaflow-upload');
}

/** 单次上传的 multer 实例（按请求构造：大小上限来自运行时配置，而不是编译期常量）。 */
function buildUploader(maxBytes: number) {
  const dir = mediaTempDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req, file, callback) => {
        // 不信任客户端文件名：只保留短后缀，其余用 uuid
        const extension = extname(file.originalname).slice(0, 12);
        callback(null, `${randomUUID()}${extension}`);
      },
    }),
    limits: { fileSize: maxBytes, files: 1 },
  }).single('file');
}

/**
 * 上传拦截器：文件**流式落盘**再校验，绝不整块进内存。
 *
 * 旧实现用 `memoryStorage` + 2GB 硬上限：一个请求就能把 8G 内存打爆（审计 P2-3）。
 * 现在：diskStorage（uuid 文件名，临时目录 0700）→ multer 按配置上限截断（超限 **413**）→
 * Redis 并发计数（默认每人 3 个，超限 **429**，finally 归还）→
 * 魔数/类型校验与原子移动到最终目录由 MediaService.uploadFromTemp 完成（失败即删临时文件）。
 */
@Injectable()
export class MediaUploadInterceptor implements NestInterceptor {
  constructor(private readonly limiter: MediaUploadLimiter) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const userId = request.user?.id ?? 'anonymous';

    await this.limiter.acquire(userId);

    try {
      const maxBytes = Math.max(1, runtime().media.maxFileMb) * 1024 * 1024;
      const uploader = buildUploader(maxBytes);
      await new Promise<void>((resolve, reject) => {
        uploader(request as never, {} as never, (error: unknown) => {
          if (!error) return resolve();
          const code = (error as { code?: string }).code ?? '';
          const message = error instanceof Error ? error.message : String(error);
          if (code === 'LIMIT_FILE_SIZE' || /file too large/i.test(message)) {
            return reject(
              new PayloadTooLargeException(
                `文件过大，单文件上限 ${runtime().media.maxFileMb}MB（可在「设置 → 素材库」调整）`,
              ),
            );
          }
          if (code === 'LIMIT_UNEXPECTED_FILE' || /unexpected field/i.test(message)) {
            return reject(new BadRequestException('表单字段名必须是 file，且一次只允许上传一个文件'));
          }
          return reject(error);
        });
      });
    } catch (error) {
      await this.limiter.release(userId);
      throw error;
    }

    // finalize 在成功与失败两条路径上都会执行 → 计数不会泄漏
    return next.handle().pipe(finalize(() => void this.limiter.release(userId)));
  }
}
