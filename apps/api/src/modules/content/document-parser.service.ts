import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { extname } from 'node:path';

export interface ParsedDocument {
  fileName: string;
  fileType: string;
  text: string;
  charCount: number;
  warnings: string[];
}

export interface KnowledgeChunk {
  index: number;
  title: string;
  content: string;
  charCount: number;
}

export const SUPPORTED_DOCUMENT_TYPES = ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.md', '.markdown'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;

/**
 * 文档解析：把上传的 PDF / Word / Excel / 文本转成纯文本，再切成适合喂给 AI 的片段。
 * 解析失败会明确报错，不返回半成品内容。
 */
@Injectable()
export class DocumentParserService {
  private readonly logger = new Logger(DocumentParserService.name);

  assertSupported(fileName: string, size: number): string {
    const type = extname(fileName).toLowerCase();
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

    try {
      switch (type) {
        case '.pdf':
          text = await this.parsePdf(buffer);
          break;
        case '.docx':
          text = await this.parseDocx(buffer);
          break;
        case '.xlsx':
        case '.xls':
        case '.csv':
          text = await this.parseSpreadsheet(buffer, type, warnings);
          break;
        default:
          text = buffer.toString('utf8');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`解析失败 ${fileName}：${message}`);
      throw new BadRequestException(`文档解析失败：${message}`);
    }

    text = this.normalize(text);
    if (text.length < 20) {
      throw new BadRequestException('解析出的文本过少（可能是扫描版 PDF 或纯图片文档），请改用文字版文件或手动录入');
    }
    if (text.length > 500000) {
      warnings.push('文档较长，已截断到 50 万字符');
      text = text.slice(0, 500000);
    }
    return { fileName, fileType: type, text, charCount: text.length, warnings };
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
        // 超长段落按定长切，带重叠避免语义被切断
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
    const cleaned = firstLine.replace(/^[#*\-\d.、\s]+/, '').slice(0, 40);
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
    // 动态 require：pdf-parse 在模块顶层会读取测试文件，直接 import 会在启动时报错
    const pdfParse = (await import('pdf-parse')).default as (data: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    return result.text;
  }

  private async parseDocx(buffer: Buffer): Promise<string> {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
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
        const cells = (row as unknown as Array<string | number>).filter((cell) => cell !== undefined && cell !== null && String(cell).trim() !== '');
        if (cells.length === 0) continue;
        lines.push(cells.join(' | '));
      }
      lines.push('');
    }
    if (workbook.SheetNames.length > 5) warnings.push(`文档含 ${workbook.SheetNames.length} 个工作表，已全部解析`);
    return lines.join('\n');
  }
}
