import { BadRequestException } from '@nestjs/common';

/**
 * 表格读取适配层（xlsx → exceljs 迁移，任务 5）。
 *
 * 背景：npm 上的 `xlsx`（SheetJS）停留在 0.18.5 且带有原型污染 / ReDoS 漏洞，
 * 官方已把新版本挪到自有 CDN，npm 包不再维护 → 改用 `exceljs`。
 *
 * 兼容性差异：
 * - exceljs 只支持 .xlsx（不支持旧版 .xls / .xlsb），调用方需把 .xls 明确拒绝并提示另存；
 * - CSV/TSV 不再交给表格库：这里自带 RFC4180 风格解析（支持引号转义与自定义分隔符），
 *   因为上游可能已经把 GBK/Big5 文本解码成字符串再传进来。
 */
export interface WorkbookMatrix {
  sheetNames: string[];
  /** 取某个工作表的行矩阵（每行是单元格数组，已去除尾部空格；空行/空单元格保留为 ''） */
  rowsOf: (sheetName: string) => Array<Array<string | number>>;
}

/** 解析 CSV/TSV 文本（支持双引号包裹、双写引号转义、字段内换行）。 */
export function parseDelimitedText(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') continue;
    field += char;
  }
  row.push(field);
  rows.push(row);

  // 去掉全空的尾行与每行尾部的空单元格
  return rows
    .map((cells) => {
      const trimmed = [...cells];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
      return trimmed;
    })
    .filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** 读取 xlsx（exceljs）或已解码的 CSV/TSV 文本。 */
export async function readWorkbook(input: { buffer?: Buffer; text?: string; delimiter?: string }): Promise<WorkbookMatrix> {
  if (input.text !== undefined) {
    const matrix = parseDelimitedText(input.text, input.delimiter ?? ',');
    return { sheetNames: ['Sheet1'], rowsOf: () => matrix };
  }

  if (!input.buffer) throw new BadRequestException('没有可解析的文件内容');

  const mod = await import('exceljs');
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(input.buffer as unknown as ArrayBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(
      /zip|corrupt|end of central directory/i.test(message)
        ? '无法解析该表格：文件可能已损坏或是旧版 .xls 格式，请另存为 .xlsx 后重试'
        : `无法解析该表格：${message}`,
    );
  }

  const sheets = new Map<string, Array<Array<string | number>>>();
  for (const worksheet of workbook.worksheets) {
    const rows: Array<Array<string | number>> = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const cells = values.map((cell) => {
        if (cell === null || cell === undefined) return '';
        if (typeof cell === 'number' || typeof cell === 'string') return cell;
        if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
        if (cell instanceof Date) return cell.toISOString();
        const rich = cell as { richText?: Array<{ text?: string }>; text?: string; result?: unknown; formula?: string };
        if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text ?? '').join('');
        if (typeof rich.text === 'string') return rich.text;
        if (rich.result !== undefined) return String(rich.result);
        return '';
      });
      while (cells.length > 0 && String(cells[cells.length - 1]).trim() === '') cells.pop();
      if (cells.length > 0) rows.push(cells);
    });
    sheets.set(worksheet.name, rows);
  }

  const sheetNames = [...sheets.keys()];
  return { sheetNames, rowsOf: (sheetName: string) => sheets.get(sheetName) ?? [] };
}
