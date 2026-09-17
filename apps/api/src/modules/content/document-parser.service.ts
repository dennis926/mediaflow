import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { runtime } from '../settings/runtime-config';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { OcrService } from './ocr.service';

const execFileAsync = promisify(execFile);

/** 解析出的文字段落；fromOcr 标记该段来自图片识别，人工复核时需重点核对。 */
export interface ParsedSegment {
  text: string;
  fromOcr: boolean;
}

export interface ParsedDocument {
  fileName: string;
  fileType: string;
  text: string;
  charCount: number;
  warnings: string[];
  /** 经过 OCR 得到的文字段落数，便于运营判断是否依赖了图片内容。 */
  ocrSections: number;
  /** 分来源的段落，切片时不会把 OCR 文字和正文混在一片里。 */
  segments: ParsedSegment[];
}

export interface KnowledgeChunk {
  index: number;
  title: string;
  content: string;
  charCount: number;
  fromOcr: boolean;
}

export const SUPPORTED_DOCUMENT_TYPES = [
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.xls',
  '.csv',
  '.txt',
  '.md',
  '.markdown',
] as const;

/** 上传层硬上限（安全护栏）：真正的业务上限来自配置 KB_MAX_DOCUMENT_MB。 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const config = (): ReturnType<typeof runtime>['knowledge'] => runtime().knowledge;

/**
 * 文档解析：PDF / Word / PPT / Excel / 文本 → 纯文本，再切成适合喂给 AI 的片段。
 * 图片里的文字用本地 tesseract OCR（离线、免费、不调用 AI 接口）。
 */
@Injectable()
export class DocumentParserService {
  private readonly logger = new Logger(DocumentParserService.name);

  constructor(private readonly ocr: OcrService) {}

  assertSupported(fileName: string, size: number): string {
    const type = extname(fileName).toLowerCase();
    if (type === '.ppt') {
      throw new BadRequestException('不支持老版 .ppt 格式，请在 Office 里另存为 .pptx 后重试');
    }
    if (!SUPPORTED_DOCUMENT_TYPES.includes(type as (typeof SUPPORTED_DOCUMENT_TYPES)[number])) {
      throw new BadRequestException(`不支持的文件类型 ${type || '(无扩展名)'}，目前支持：${SUPPORTED_DOCUMENT_TYPES.join('、')}`);
    }
    const limitBytes = config().maxDocumentMb * 1024 * 1024;
    if (size > limitBytes) {
      throw new BadRequestException(`文件过大（${(size / 1024 / 1024).toFixed(1)}MB），单文件上限 ${config().maxDocumentMb}MB`);
    }
    if (size === 0) throw new BadRequestException('文件内容为空');
    return type;
  }

  async parse(fileName: string, buffer: Buffer): Promise<ParsedDocument> {
    const type = this.assertSupported(fileName, buffer.length);
    const warnings: string[] = [];
    const segments: ParsedSegment[] = [];
    let ocrSections = 0;

    try {
      switch (type) {
        case '.pdf': {
          const text = await this.parsePdf(buffer);
          if (text.replace(/\s/g, '').length < 100) {
            // No text layer (scanned or image-only PDF): render the pages and OCR them locally.
            const ocr = await this.ocrPdfPages(buffer, warnings);
            if (ocr.text) {
              ocrSections = ocr.sections;
              segments.push({ text: `【扫描页文字（本地 OCR）】\n${ocr.text}`, fromOcr: true });
              warnings.push('该 PDF 没有文字层，已用本地 OCR 识别图片文字，请重点核对');
            }
          } else {
            segments.push({ text, fromOcr: false });
          }
          break;
        }
        case '.docx': {
          const body = await this.parseDocx(buffer);
          if (body.trim().length > 0) segments.push({ text: body, fromOcr: false });
          const media = await this.ocrZipMedia(buffer, /^word\/media\//, warnings);
          if (media.text) {
            ocrSections = media.sections;
            segments.push({ text: `【文档内图片文字（本地 OCR）】\n${media.text}`, fromOcr: true });
            warnings.push('文档内图片文字由本地 OCR 识别，请重点核对');
          }
          break;
        }
        case '.pptx': {
          const pptx = await this.parsePptx(buffer, warnings);
          if (pptx.text.trim().length > 0) segments.push({ text: pptx.text, fromOcr: false });
          if (pptx.imageText) {
            ocrSections = pptx.sections;
            segments.push({ text: `【幻灯片图片文字（本地 OCR）】\n${pptx.imageText}`, fromOcr: true });
            warnings.push('幻灯片内图片文字由本地 OCR 识别，请重点核对');
          }
          break;
        }
        case '.xlsx':
        case '.xls':
        case '.csv':
          segments.push({ text: await this.parseSpreadsheet(buffer, type, warnings), fromOcr: false });
          break;
        default:
          segments.push({ text: buffer.toString('utf8'), fromOcr: false });
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`解析失败 ${fileName}：${message}`);
      throw new BadRequestException(`文档解析失败：${message}`);
    }

    const cleaned = segments
      .map((segment) => ({ text: this.normalize(segment.text), fromOcr: segment.fromOcr }))
      .filter((segment) => segment.text.replace(/\s/g, '').length > 0);

    let text = cleaned.map((segment) => segment.text).join('\n\n');
    if (text.replace(/\s/g, '').length < 20) {
      throw new BadRequestException('解析出的文本过少（可能是扫描件且 OCR 未识别到文字），请改用文字版文件或手动录入');
    }
    if (text.length > 500000) {
      warnings.push('文档较长，已截断到 50 万字符');
      text = text.slice(0, 500000);
    }

    return { fileName, fileType: type, text, charCount: text.length, warnings, ocrSections, segments: cleaned };
  }

  /**
   * 按来源分段切片：OCR 段落与正文段落分别切片，不混在同一片里，
   * 这样运营能一眼看出哪些内容来自图片识别、需要重点校对。
   */
  chunkSegments(segments: ParsedSegment[], maxChunks = 40): KnowledgeChunk[] {
    const chunks: KnowledgeChunk[] = [];
    for (const segment of segments) {
      if (chunks.length >= maxChunks) break;
      for (const chunk of this.chunk(segment.text, maxChunks - chunks.length)) {
        chunks.push({ ...chunk, index: chunks.length + 1, fromOcr: segment.fromOcr });
      }
    }
    return chunks.slice(0, maxChunks).map((chunk, position) => ({ ...chunk, index: position + 1 }));
  }

  /** 按空行/标题切段，再按长度合并成 1200 字左右、带 200 字重叠的片段。 */
  chunk(text: string, maxChunks = 40): KnowledgeChunk[] {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);

    const CHUNK_SIZE = config().chunkSize;
    const CHUNK_OVERLAP = Math.min(config().chunkOverlap, Math.floor(CHUNK_SIZE / 2));
    const chunks: KnowledgeChunk[] = [];
    let buffer = '';

    const flush = (): void => {
      const content = buffer.trim();
      if (content.length >= 40) {
        chunks.push({ index: chunks.length + 1, title: this.deriveTitle(content), content, charCount: content.length, fromOcr: false });
      }
      buffer = '';
    };

    for (const paragraph of paragraphs) {
      if (paragraph.length > CHUNK_SIZE) {
        flush();
        for (let start = 0; start < paragraph.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
          const slice = paragraph.slice(start, start + CHUNK_SIZE).trim();
          if (slice.length >= 40) {
            chunks.push({ index: chunks.length + 1, title: this.deriveTitle(slice), content: slice, charCount: slice.length, fromOcr: false });
          }
          if (chunks.length >= maxChunks) break;
        }
      } else if ((buffer + '\n' + paragraph).length > CHUNK_SIZE) {
        flush();
        buffer = paragraph;
      } else {
        buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
      }
      if (chunks.length >= maxChunks) break;
    }
    flush();

    return chunks.slice(0, maxChunks).map((chunk, position) => ({ ...chunk, index: position + 1 }));
  }

  private deriveTitle(content: string): string {
    const firstLine = content.split('\n')[0].trim();
    const cleaned = firstLine.replace(/^[#*\-0-9.、\s]+/, '').slice(0, 40);
    return cleaned.length >= 4 ? cleaned : `片段 ${content.slice(0, 12).replace(/\n/g, ' ')}`;
  }

  private normalize(text: string): string {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private async parsePdf(buffer: Buffer): Promise<string> {
    // 动态 import：pdf-parse 在模块顶层会读取调试文件，直接 import 会在启动时报错
    const pdfParse = (await import('pdf-parse')).default as (data: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    return result.text;
  }

  private async parseDocx(buffer: Buffer): Promise<string> {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  /** PPT：按幻灯片顺序取文本框文字，再对幻灯片图片做本地 OCR。 */
  private async parsePptx(buffer: Buffer, warnings: string[]): Promise<{ text: string; imageText: string; sections: number }> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => this.slideNumber(left) - this.slideNumber(right));

    if (slideNames.length === 0) throw new BadRequestException('未找到幻灯片内容，请确认是 .pptx 文件');

    const parts: string[] = [];
    for (const name of slideNames) {
      const xml = await zip.file(name)?.async('string');
      if (!xml) continue;
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => this.decodeXml(match[1]).trim()).filter(Boolean);
      if (texts.length === 0) continue;
      parts.push(`【第 ${this.slideNumber(name)} 页】\n${texts.join('\n')}`);
    }

    const media = await this.ocrZipMedia(buffer, /^ppt\/media\//, warnings);
    return { text: parts.join('\n\n'), imageText: media.text, sections: media.sections };
  }

  /** 读取压缩包内图片并逐张 OCR（docx 的 word/media、pptx 的 ppt/media）。 */
  private async ocrZipMedia(buffer: Buffer, prefix: RegExp, warnings: string[]): Promise<{ text: string; sections: number }> {
    if (!config().ocrEnabled || !this.ocr.available) return { text: '', sections: 0 };
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const images = Object.keys(zip.files)
      .filter((name) => prefix.test(name) && /\.(png|jpe?g|bmp|webp)$/i.test(name))
      .sort();

    if (images.length === 0) return { text: '', sections: 0 };
    const limited = images.slice(0, config().ocrMaxImages);
    if (images.length > limited.length) {
      warnings.push(`文档含 ${images.length} 张图片，仅识别前 ${limited.length} 张`);
    }

    const parts: string[] = [];
    for (const name of limited) {
      const file = zip.file(name);
      if (!file) continue;
      const image = Buffer.from(await file.async('uint8array'));
      const result = await this.ocr.recognize(image, name);
      if (result.ok) parts.push(result.text);
    }
    return { text: parts.join('\n\n'), sections: parts.length };
  }

  /** 扫描版 PDF：用 poppler 把前若干页渲染成图片再 OCR。 */
  private async ocrPdfPages(buffer: Buffer, warnings: string[]): Promise<{ text: string; sections: number }> {
    if (!config().ocrEnabled || !this.ocr.available) return { text: '', sections: 0 };
    const dir = mkdtempSync(join(tmpdir(), 'mediaflow-pdf-'));
    const pdfPath = join(dir, 'input.pdf');
    try {
      writeFileSync(pdfPath, buffer);
      await execFileAsync(
        'pdftoppm',
        ['-png', '-r', String(config().ocrDpi), '-f', '1', '-l', String(config().ocrPdfMaxPages), pdfPath, join(dir, 'page')],
        { timeout: 60_000 },
      );
      const pages = readdirSync(dir).filter((name) => name.endsWith('.png')).sort();
      if (pages.length === 0) {
        warnings.push('PDF 渲染失败，未能提取图片文字');
        return { text: '', sections: 0 };
      }
      if (pages.length >= config().ocrPdfMaxPages) warnings.push(`PDF 页数较多，仅识别前 ${config().ocrPdfMaxPages} 页`);

      const parts: string[] = [];
      for (const [index, page] of pages.entries()) {
        const result = await this.ocr.recognize(readFileSync(join(dir, page)), `第 ${index + 1} 页`);
        if (result.ok) parts.push(result.text);
      }
      return { text: parts.join('\n\n'), sections: parts.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async parseSpreadsheet(buffer: Buffer, type: string, warnings: string[]): Promise<string> {
    // 按需加载：xlsx 体积较大，只在真的解析表格时引入
    const XLSX = await import('xlsx');
    const workbook = type === '.csv'
      ? XLSX.read(buffer.toString('utf8'), { type: 'string' })
      : XLSX.read(buffer, { type: 'buffer' });

    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false });
      if (rows.length === 0) continue;
      lines.push(`【工作表：${sheetName}】`);
      for (const row of rows) {
        const cells = (row as unknown as Array<string | number>).filter(
          (cell) => cell !== undefined && cell !== null && String(cell).trim() !== '',
        );
        if (cells.length === 0) continue;
        lines.push(cells.join(' | '));
      }
      lines.push('');
    }
    if (workbook.SheetNames.length > 5) warnings.push(`文档含 ${workbook.SheetNames.length} 个工作表，已全部解析`);
    return lines.join('\n');
  }

  private slideNumber(path: string): number {
    return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  }

  private decodeXml(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
}
