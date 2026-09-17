import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_OCR_IMAGES, OcrService } from './ocr.service';

const execFileAsync = promisify(execFile);

export interface ParsedDocument {
  fileName: string;
  fileType: string;
  text: string;
  charCount: number;
  warnings: string[];
  /** 经过 OCR 得到的文字段落数，便于运营判断是否依赖了图片内容。 */
  ocrSections: number;
}

export interface KnowledgeChunk {
  index: number;
  title: string;
  content: string;
  charCount: number;
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

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_PDF_OCR_PAGES = 10;
const PDF_OCR_DPI = 200;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;

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
    if (size > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(`文件过大（${(size / 1024 / 1024).toFixed(1)}MB），单文件上限 ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB`);
    }
    if (size === 0) throw new BadRequestException('文件内容为空');
    return type;
  }

  async parse(fileName: string, buffer: Buffer): Promise<ParsedDocument> {
    const type = this.assertSupported(fileName, buffer.length);
    const warnings: string[] = [];
    let text = '';
    let ocrSections = 0;

    try {
      switch (type) {
        case '.pdf': {
          text = await this.parsePdf(buffer);
          if (text.replace(/\s/g, '').length < 100) {
            // 没有文字层（扫描版/纯图片 PDF）→ 渲染成图片后本地 OCR
            const ocrText = await this.ocrPdfPages(buffer, warnings);
            if (ocrText) {
              text = ocrText.text;
              ocrSections = ocrText.sections;
              warnings.push('该 PDF 没有文字层，已用本地 OCR 识别图片文字');
            }
          }
          break;
        }
        case '.docx': {
          text = await this.parseDocx(buffer);
          const media = await this.ocrZipMedia(buffer, /^word\/media\//, warnings);
          if (media.text) {
            text = `${text}\n\n【文档内图片文字】\n${media.text}`;
            ocrSections = media.sections;
          }
          break;
        }
        case '.pptx': {
          const pptx = await this.parsePptx(buffer, warnings);
          text = pptx.text;
          ocrSections = pptx.sections;
          break;
        }
        case '.xlsx':
        case '.xls':
        case '.csv':
          text = await this.parseSpreadsheet(buffer, type, warnings);
          break;
        default:
          text = buffer.toString('utf8');
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`解析失败 ${fileName}：${message}`);
      throw new BadRequestException(`文档解析失败：${message}`);
    }

    text = this.normalize(text);
    if (text.replace(/\s/g, '').length < 20) {
      throw new BadRequestException('解析出的文本过少（可能是扫描件且 OCR 未识别到文字），请改用文字版文件或手动录入');
    }
    if (text.length > 500000) {
      warnings.push('文档较长，已截断到 50 万字符');
      text = text.slice(0, 500000);
    }
    return { fileName, fileType: type, text, charCount: text.length, warnings, ocrSections };
  }

  /** 按空行/标题切段，再按长度合并成 1200 字左右、带 200 字重叠的片段。 */
  chunk(text: string, maxChunks = 40): KnowledgeChunk[] {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);

    const chunks: KnowledgeChunk[] = [];
    let buffer = '';

    const flush = (): void => {
      const content = buffer.trim();
      if (content.length >= 40) {
        chunks.push({ index: chunks.length + 1, title: this.deriveTitle(content), content, charCount: content.length });
      }
      buffer = '';
    };

    for (const paragraph of paragraphs) {
      if (paragraph.length > CHUNK_SIZE) {
        flush();
        for (let start = 0; start < paragraph.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
          const slice = paragraph.slice(start, start + CHUNK_SIZE).trim();
          if (slice.length >= 40) {
            chunks.push({ index: chunks.length + 1, title: this.deriveTitle(slice), content: slice, charCount: slice.length });
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
  private async parsePptx(buffer: Buffer, warnings: string[]): Promise<{ text: string; sections: number }> {
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
    if (media.text) parts.push(`【幻灯片图片文字（本地 OCR）】\n${media.text}`);

    return { text: parts.join('\n\n'), sections: media.sections };
  }

  /** 读取压缩包内图片并逐张 OCR（docx 的 word/media、pptx 的 ppt/media）。 */
  private async ocrZipMedia(buffer: Buffer, prefix: RegExp, warnings: string[]): Promise<{ text: string; sections: number }> {
    if (!this.ocr.available) return { text: '', sections: 0 };
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const images = Object.keys(zip.files)
      .filter((name) => prefix.test(name) && /\.(png|jpe?g|bmp|webp)$/i.test(name))
      .sort();

    if (images.length === 0) return { text: '', sections: 0 };
    const limited = images.slice(0, MAX_OCR_IMAGES);
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
    if (!this.ocr.available) return { text: '', sections: 0 };
    const dir = mkdtempSync(join(tmpdir(), 'mediaflow-pdf-'));
    const pdfPath = join(dir, 'input.pdf');
    try {
      writeFileSync(pdfPath, buffer);
      await execFileAsync(
        'pdftoppm',
        ['-png', '-r', String(PDF_OCR_DPI), '-f', '1', '-l', String(MAX_PDF_OCR_PAGES), pdfPath, join(dir, 'page')],
        { timeout: 60_000 },
      );
      const pages = readdirSync(dir).filter((name) => name.endsWith('.png')).sort();
      if (pages.length === 0) {
        warnings.push('PDF 渲染失败，未能提取图片文字');
        return { text: '', sections: 0 };
      }
      if (pages.length >= MAX_PDF_OCR_PAGES) warnings.push(`PDF 页数较多，仅识别前 ${MAX_PDF_OCR_PAGES} 页`);

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
