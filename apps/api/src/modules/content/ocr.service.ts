import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface OcrResult {
  text: string;
  ok: boolean;
  error?: string;
}

/** 每次导入最多识别的图片数（OCR 是 CPU 密集操作，必须设上限）。 */
export const MAX_OCR_IMAGES = 20;
const OCR_TIMEOUT_MS = 30_000;
const MIN_IMAGE_BYTES = 3 * 1024;

/**
 * 本地 OCR（tesseract，离线运行、不调用任何 AI 接口）。
 * 用于 PPT/Word/扫描版 PDF 里"文字在图片上"的情况。
 */
@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private readonly languages = process.env.OCR_LANGUAGES ?? 'chi_sim+eng';
  private queue: Promise<unknown> = Promise.resolve();

  get available(): boolean {
    return process.env.OCR_ENABLED !== 'false';
  }

  /** 串行执行，避免多文件同时 OCR 把 CPU 打满。 */
  async recognize(image: Buffer, hint = ''): Promise<OcrResult> {
    if (!this.available) return { text: '', ok: false, error: 'OCR 已禁用（OCR_ENABLED=false）' };
    if (image.length < MIN_IMAGE_BYTES) return { text: '', ok: false, error: '图片过小，跳过' };

    const task = this.queue.then(() => this.runTesseract(image, hint));
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** 用中文字符数量衡量识别质量（中文内容里 CJK 越多通常越准确）。 */
  private cjkCount(text: string): number {
    return (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  }

  private async runTesseract(image: Buffer, hint: string): Promise<OcrResult> {
    const dir = mkdtempSync(join(tmpdir(), 'mediaflow-ocr-'));
    const file = join(dir, 'image.png');
    try {
      writeFileSync(file, image);
      // 两种版面模式各跑一次，取"中文字符更多"的结果：
      // psm 3 适合普通文档，psm 6 对幻灯片/海报这类大标题排版更稳。
      const candidates: string[] = [];
      for (const psm of ['3', '6']) {
        const { stdout } = await execFileAsync('tesseract', [file, 'stdout', '-l', this.languages, '--psm', psm], {
          timeout: OCR_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
        candidates.push(stdout.replace(/\n{3,}/g, '\n\n').trim());
      }
      const best = candidates.sort((left, right) => this.cjkCount(right) - this.cjkCount(left))[0];
      if (best.length === 0) return { text: '', ok: false, error: '未识别到文字' };
      return { text: best, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      this.logger.warn(`OCR 失败${hint ? `（${hint}）` : ''}：${message}`);
      return { text: '', ok: false, error: message };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
