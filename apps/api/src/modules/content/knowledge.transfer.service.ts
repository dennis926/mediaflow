import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformCode } from '@mediaflow/shared';

/**
 * 知识库导入导出。
 *
 * 导出支持三种格式：
 * - json：本项目原生格式（含分类配置，便于整站迁移）
 * - csv：通用表格（中英双语表头识别，方便用 Excel 打开或喂给其他系统）
 * - markdown：每条资料一个 `## 标题` 段落，方便人读、也方便被其他工具导入
 *
 * 导入尽量兼容外部系统导出的内容：CSV/TSV/Excel/Markdown/JSON 都能读，
 * 字段名支持中英文别名自动识别，识别不准时由用户在界面上改映射后提交。
 */

export type ExportFormat = 'json' | 'csv' | 'markdown';

export interface TransferEntry {
  brand: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  keywords: string[];
  priority: number;
  isActive: boolean;
  aiGenerated: boolean;
  platforms?: PlatformCode[];
}

export interface ParsedTable {
  /** 源文件里出现的列名（原样保留，便于界面展示） */
  columns: string[];
  /** 每行是"列名 → 单元格文本"，未做任何字段解释 */
  rows: Array<Record<string, string>>;
  format: 'tabular' | 'json' | 'markdown';
  warnings: string[];
}

export interface FieldMapping {
  title?: string;
  content?: string;
  brand?: string;
  category?: string;
  tags?: string;
  keywords?: string;
  priority?: string;
  isActive?: string;
}

export type MappingTarget = keyof FieldMapping;

export const MAPPING_TARGETS: MappingTarget[] = ['title', 'content', 'brand', 'category', 'tags', 'keywords', 'priority', 'isActive'];

export const TARGET_LABELS: Record<MappingTarget, string> = {
  title: '标题',
  content: '正文',
  brand: '品牌',
  category: '分类',
  tags: '标签',
  keywords: '关键词',
  priority: '优先级',
  isActive: '是否启用',
};

/** 字段别名表：覆盖常见中文知识库/问答系统导出的表头（Dify、FastGPT、Coze、RAGFlow、Notion 等）。 */
const FIELD_ALIASES: Record<MappingTarget, string[]> = {
  title: ['title', '标题', '名称', 'name', 'question', '问题', '主题', 'subject', '摘要标题', 'topic', '名称/标题'],
  content: ['content', '内容', '正文', 'body', 'answer', '答案', 'text', '文本', '描述', 'description', 'segment', '分段内容', 'chunk', '详细内容', '内容片段', 'value'],
  brand: ['brand', '品牌', '品牌名', '公司', 'company', '产品', 'product', '所属品牌', '产品名'],
  category: ['category', '分类', '类别', '类型', 'type', 'kind', '分类名称', '标签分类', '分类目录'],
  tags: ['tags', 'tag', '标签', '标签列表', '分类标签', 'labels'],
  keywords: ['keywords', 'keyword', '关键词', '关键字', '检索词', '关键短语', 'key_words'],
  priority: ['priority', '优先级', '权重', 'weight', 'order', '排序', 'sort'],
  isActive: ['isactive', 'is_active', '启用', '是否启用', 'active', 'enabled', '状态', 'status', '有效'],
};

/** 归一化表头：去空白、全角转半角、小写，去掉常见后缀/单位。 */
function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-（）()【】[\]]/g, '')
    .replace(/[（(].*?[)）]/g, '');
}

export function autoMapColumns(columns: string[]): FieldMapping {
  const mapping: FieldMapping = {};
  const taken = new Set<string>();
  const normalized = columns.map((column) => ({ column, key: normalizeHeader(column) }));

  for (const target of MAPPING_TARGETS) {
    const aliases = FIELD_ALIASES[target].map(normalizeHeader);
    const exact = normalized.find((item) => !taken.has(item.column) && aliases.includes(item.key));
    const fuzzy =
      exact ??
      normalized.find((item) => !taken.has(item.column) && aliases.some((alias) => alias.length > 2 && item.key.includes(alias)));
    if (fuzzy) {
      mapping[target] = fuzzy.column;
      taken.add(fuzzy.column);
    }
  }
  return mapping;
}

/** 把单元格文本按常见分隔符拆成数组。 */
function splitList(value: string): string[] {
  return value
    .split(/[、,，;；|/\n]+/)
    .map((item) => item.replace(/^[-*\s]+/, '').trim())
    .filter((item) => item.length > 0 && !['无', 'null', 'none', '-'].includes(item.toLowerCase()))
    .slice(0, 20);
}

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['true', '1', 'yes', 'y', '是', '启用', '有效', 'active', 'enabled'].includes(value.trim().toLowerCase());
}

@Injectable()
export class KnowledgeTransferService {
  /** 导出为 csv（带 BOM，Excel 打开不乱码）。 */
  toCsv(entries: TransferEntry[]): string {
    const headers = ['title', 'content', 'category', 'brand', 'tags', 'keywords', 'priority', 'is_active', 'ai_generated'];
    const escape = (value: string): string => {
      const text = value ?? '';
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [headers.join(',')];
    for (const entry of entries) {
      lines.push(
        [
          escape(entry.title),
          escape(entry.content),
          escape(entry.category),
          escape(entry.brand),
          escape(entry.tags.join('、')),
          escape(entry.keywords.join('、')),
          String(entry.priority),
          entry.isActive ? 'true' : 'false',
          entry.aiGenerated ? 'true' : 'false',
        ].join(','),
      );
    }
    return `\uFEFF${lines.join('\n')}\n`;
  }

  /** 导出为 markdown：每条一个二级标题 + 元信息行，人能读、机器也能再解析回来。 */
  toMarkdown(entries: TransferEntry[], categoryLabels: Map<string, string>): string {
    const lines: string[] = ['# MediaFlow 知识库导出', '', `共 ${entries.length} 条资料`, ''];
    for (const entry of entries) {
      lines.push(`## ${entry.title}`);
      lines.push('');
      lines.push(
        [
          `- 品牌：${entry.brand}`,
          `- 分类：${categoryLabels.get(entry.category) ?? entry.category}（${entry.category}）`,
          entry.tags.length ? `- 标签：${entry.tags.join('、')}` : '',
          entry.keywords.length ? `- 关键词：${entry.keywords.join('、')}` : '',
          `- 优先级：${entry.priority}`,
          `- 状态：${entry.isActive ? '启用' : '停用'}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      lines.push('');
      lines.push(entry.content);
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 识别并解析上传的文件：表格（csv/tsv/xlsx）、Markdown、JSON 都收敛成"行对象"。 */
  async parseFile(fileName: string, buffer: Buffer): Promise<ParsedTable> {
    const lower = fileName.toLowerCase();
    const warnings: string[] = [];

    if (lower.endsWith('.json')) return this.parseJson(buffer, warnings);
    if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
      const text = buffer.toString('utf8');
      // 纯文本里如果明显是 JSON（有些系统导出 .txt 的 JSON），也按 JSON 处理
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) return this.parseJson(buffer, warnings);
      return this.parseMarkdown(text, warnings);
    }
    if (/\.(csv|tsv|xlsx|xls)$/.test(lower)) return this.parseTabular(buffer, lower, warnings);

    throw new BadRequestException('仅支持 .json/.csv/.tsv/.xlsx/.xls/.md/.txt 格式的知识库文件');
  }

  private parseJson(buffer: Buffer, warnings: string[]): ParsedTable {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      throw new BadRequestException('JSON 文件解析失败，请确认文件完整');
    }

    // 本项目原生格式：{ format, version, items: [...] }
    const container = parsed as Record<string, unknown>;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(container.items)
        ? container.items
        : Array.isArray(container.data)
          ? container.data
          : Array.isArray(container.list)
            ? container.list
            : null;

    if (!list) throw new BadRequestException('JSON 里没有找到资料数组（需要是数组，或含 items/data/list 字段）');
    if (container.format && container.format !== 'mediaflow.knowledge') {
      warnings.push(`来源格式标记为 ${String(container.format)}，已按通用 JSON 处理`);
    }

    const rows: Array<Record<string, string>> = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const row: Record<string, string> = {};
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        row[key] = Array.isArray(value) ? value.map((entry) => String(entry)).join('、') : String(value);
      }
      // 统一成字符串行，前端回传时不会带出布尔/数组类型
      if (Object.keys(row).length > 0) rows.push(row);
    }
    if (rows.length === 0) throw new BadRequestException('JSON 里没有可导入的资料');
    return { columns: Object.keys(rows[0]), rows, format: 'json', warnings };
  }

  private parseMarkdown(text: string, warnings: string[]): ParsedTable {
    const blocks = text.split(/\n(?=##\s)/);
    const rows: Array<Record<string, string>> = [];

    for (const block of blocks) {
      const trimmed = block.trim();
      if (trimmed.length === 0) continue;
      const headingMatch = trimmed.match(/^##\s+(.+)$/m);
      // 文件开头的"# 标题/说明"导语块不算一条资料；只有整篇没有 ## 时才退化成单条
      if (!headingMatch && /^#\s/.test(trimmed)) continue;
      const body = headingMatch ? trimmed.slice(trimmed.indexOf('\n') + 1).trim() : trimmed;
      if (body.length < 20) continue;

      const row: Record<string, string> = { title: headingMatch ? headingMatch[1].trim() : this.firstLine(body) };
      // 元信息行：- 品牌：xx / 分类 / 标签 / 关键词 / 优先级
      const brand = body.match(/^[-*]\s*(?:品牌|brand)[:：]\s*(.+)$/m)?.[1];
      const category = body.match(/^[-*]\s*(?:分类|category)[:：]\s*(.+)$/m)?.[1];
      const tags = body.match(/^[-*]\s*(?:标签|tags?)[:：]\s*(.+)$/m)?.[1];
      const keywords = body.match(/^[-*]\s*(?:关键词|keywords?)[:：]\s*(.+)$/m)?.[1];
      const priority = body.match(/^[-*]\s*(?:优先级|priority)[:：]\s*(\d+)/m)?.[1];
      if (brand) row['品牌'] = brand.trim();
      if (category) row['分类'] = category.replace(/（[^）]*）$/, '').trim();
      if (tags) row['标签'] = tags.trim();
      if (keywords) row['关键词'] = keywords.trim();
      if (priority) row['优先级'] = priority;

      row.content = body
        .replace(/^[-*]\s*(?:品牌|brand|分类|category|标签|tags?|关键词|keywords?|优先级|priority|状态)[:：].*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (row.content.length >= 20) rows.push(row);
    }

    if (rows.length === 0) {
      // 没有 ## 结构：整篇当成一条资料
      const content = text.trim();
      if (content.length < 20) throw new BadRequestException('文件内容太少，无法识别为知识库资料');
      warnings.push('未找到「## 标题」结构，已把整个文件当成一条资料');
      rows.push({ title: this.firstLine(content), content });
    }
    return { columns: Object.keys(rows[0]), rows, format: 'markdown', warnings };
  }

  /** 文本文件编码嗅探：国内系统导出的 CSV 常见 GBK，直接按 UTF-8 读会整片乱码。 */
  decodeText(buffer: Buffer): { text: string; encoding: string } {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8（含 BOM）' };
    }
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };
    for (const encoding of ['gb18030', 'gbk', 'big5']) {
      try {
        const decoded = new TextDecoder(encoding).decode(buffer);
        if (decoded.length > 0 && !decoded.includes('\uFFFD')) return { text: decoded, encoding };
      } catch {
        // 运行时不支持该编码时跳过
      }
    }
    return { text: utf8, encoding: 'utf-8（有无法识别的字符）' };
  }

  private async parseTabular(buffer: Buffer, lower: string, warnings: string[]): Promise<ParsedTable> {
    const XLSX = await import('xlsx');
    const isDelimited = lower.endsWith('.csv') || lower.endsWith('.tsv');
    if (isDelimited) {
      const { text, encoding } = this.decodeText(buffer);
      if (encoding !== 'utf-8') warnings.push(`文件按 ${encoding} 解码读取`);
      const workbook = XLSX.read(text, { type: 'string', raw: false, FS: lower.endsWith('.tsv') ? '\t' : undefined });
      return this.matrixToTable(XLSX, workbook, warnings);
    }
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return this.matrixToTable(await import('xlsx'), workbook, warnings);
  }

  /** 表格 → 行对象（表头为第一行）。 */
  private matrixToTable(
    XLSX: typeof import('xlsx'),
    workbook: { SheetNames: string[]; Sheets: Record<string, unknown> },
    warnings: string[],
  ): ParsedTable {
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) throw new BadRequestException('表格里没有可读的工作表');
    if (workbook.SheetNames.length > 1) warnings.push(`表格含 ${workbook.SheetNames.length} 个工作表，已读取第一个「${sheetName}」`);

    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' });
    if (matrix.length < 2) throw new BadRequestException('表格至少需要一行表头和一行数据');

    const headers = (matrix[0] as unknown as Array<string | number>).map((cell, index) => {
      const text = String(cell ?? '').trim();
      return text.length > 0 ? text : `列${index + 1}`;
    });

    const rows: Array<Record<string, string>> = [];
    for (const raw of matrix.slice(1)) {
      const cells = raw as unknown as Array<string | number>;
      const row: Record<string, string> = {};
      let hasValue = false;
      headers.forEach((header, index) => {
        const value = String(cells[index] ?? '').trim();
        row[header] = value;
        if (value.length > 0) hasValue = true;
      });
      if (hasValue) rows.push(row);
    }
    if (rows.length === 0) throw new BadRequestException('表格里没有数据行');
    return { columns: headers, rows, format: 'tabular', warnings };
  }

  /** 按映射把行对象转成可入库的条目；缺少品牌/分类时用默认值补齐。 */
  buildEntries(
    rows: Array<Record<string, string>>,
    mapping: FieldMapping,
    defaults: { brand: string; category: string; priority: number; isActive: boolean },
    /** 当前生效的分类码表：外部文件里的分类名/中文标签都要归一化到这里，否则会变成界面上的"孤儿分类" */
    knownCategories: Array<{ code: string; label: string }> = [],
  ): { entries: TransferEntry[]; skipped: Array<{ row: number; reason: string }> } {
    const findByLabel = new Map(knownCategories.map((item) => [item.label.trim().toLowerCase(), item.code]));
    const codes = new Set(knownCategories.map((item) => item.code));
    const normalizeCategory = (raw: string): string => {
      const value = raw.trim();
      if (!value) return defaults.category;
      const lower = value.toLowerCase();
      if (codes.has(lower)) return lower;
      if (findByLabel.has(lower)) return findByLabel.get(lower) as string;
      return defaults.category;
    };

    const entries: TransferEntry[] = [];
    const skipped: Array<{ row: number; reason: string }> = [];

    rows.forEach((row, index) => {
      const pick = (target: MappingTarget): string => {
        const column = mapping[target];
        if (!column) return '';
        const value = row[column];
        if (value === undefined || value === null) return '';
        // 值可能来自 JSON（布尔/数字/数组），统一转成文本再处理
        return (Array.isArray(value) ? value.join('、') : String(value)).trim();
      };
      const title = pick('title') || this.firstLine(pick('content'));
      const content = pick('content');
      if (content.length < 20) {
        skipped.push({ row: index + 1, reason: '正文少于 20 字（可能字段没映射对）' });
        return;
      }
      const priorityText = pick('priority').replace(/[^\d]/g, '');
      entries.push({
        brand: pick('brand') || defaults.brand,
        category: normalizeCategory(pick('category')),
        title: (title || this.firstLine(content)).slice(0, 200),
        content,
        tags: splitList(pick('tags')),
        keywords: splitList(pick('keywords')),
        priority: priorityText ? Math.min(100, Number(priorityText)) : defaults.priority,
        isActive: mapping.isActive ? truthy(pick('isActive')) : defaults.isActive,
        aiGenerated: false,
      });
    });

    return { entries, skipped };
  }

  /** 去重签名：品牌 + 标题 + 正文前 200 字，避免同一份文件被导入两次。 */
  signature(entry: { brand: string; title: string; content: string }): string {
    return `${entry.brand}|${entry.title.trim()}|${entry.content.replace(/\s/g, '').slice(0, 200)}`;
  }

  private firstLine(text: string): string {
    const line = text.split('\n').map((item) => item.trim()).find((item) => item.length > 0) ?? '';
    return line.replace(/^[#*\-\d.、\s]+/, '').slice(0, 60) || '未命名片段';
  }
}
