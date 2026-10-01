/**
 * Shared parsing helpers for the official-price scrapers.
 *
 * Dependency-free on purpose: every vendor page we read is either a static
 * server-rendered table or a markdown document, so a small tolerant parser beats
 * pulling in a DOM library (AGENTS.md forbids unapproved dependencies). The
 * parsers must be *tolerant*: a restructured page yields fewer rows, never a
 * wrong number.
 */

import { Dimension, FetchLike, TierSlots } from './types';

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36';

/** Shared headers. `Accept` asks Mintlify-style doc sites for markdown. */
export const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,text/markdown,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export interface FetchOutcome {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * Fetch a page with a hard timeout.
 *
 * The refresh task runs on a timer in the API process; a vendor that hangs must
 * not pin a request slot forever, so every scrape is time-boxed.
 */
export async function fetchPage(
  url: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 15_000,
  extraHeaders: Record<string, string> = {},
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { ...FETCH_HEADERS, ...extraHeaders },
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    times: '×',
    middot: '·',
  };
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** Strip tags, decode entities, collapse whitespace. */
export function cellText(html: string): string {
  const withoutTags = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  // U+200B zero-width spaces are used as padding inside volcengine's editor cells.
  return decodeEntities(withoutTags).replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

export interface ParsedTable {
  rows: string[][];
}

/** All `<table>` elements on the page, each as a grid of cell strings. */
export function extractTables(html: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const tableHtml of tableMatches) {
    const rows: string[][] = [];
    const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    for (const rowHtml of rowMatches) {
      const cells: string[] = [];
      const cellMatches = rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [];
      for (const cellHtml of cellMatches) {
        cells.push(cellText(cellHtml));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push({ rows });
  }
  return tables;
}

/**
 * Pull the first number out of a cell like "0.02元", "￥1", "$0.28", "1,200".
 * Returns null when the cell has no number (e.g. "支持", "—", "N/A").
 */
export function parseNumber(cell: string): number | null {
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(cell.replace(/\s/g, ''));
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a price cell, treating "free" as 0 and non-numeric filler as null.
 *
 * Vendors write free tiers as 免费 / Free / $0; without this the row would be
 * dropped and the model would silently disappear from the price list.
 */
export function parsePriceCell(cell: string): number | null {
  const text = cell.trim();
  if (!text) return null;
  if (/免费|free|included|限时免费/i.test(text) && !/\d/.test(text)) return 0;
  if (/^(n\/?a|—|-|不支持|不适用)$/i.test(text)) return null;
  return parseNumber(text);
}

/** Does the cell contain a real number (as opposed to a dash or a label)? */
export function hasNumber(cell: string): boolean {
  return /\d/.test(cell);
}

/** Markdown table rows (`| a | b |`) parsed into cell arrays. */
export function extractMarkdownTables(markdown: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  let current: string[][] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    // Allow leading indentation: zhipu nests tables inside <Accordion> blocks.
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) {
      if (current.length) {
        tables.push({ rows: current });
        current = [];
      }
      continue;
    }
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.replace(/<br\s*\/?>/gi, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim());
    // Separator row: | --- | :-- | — vendors also write a single dash (| - | - |).
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    current.push(cells);
  }
  if (current.length) tables.push({ rows: current });
  return tables;
}

/** Find a column index by testing the header cells. */
export function columnIndex(header: string[], ...patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = header.findIndex((cell) => pattern.test(cell));
    if (index >= 0) return index;
  }
  return -1;
}

/** Numeric columns only: used to avoid latching onto a "上下文" column. */
export function numberColumnIndex(header: string[], ...patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = header.findIndex((cell) => pattern.test(cell) && !/上下文|context|窗口|window/i.test(cell));
    if (index >= 0) return index;
  }
  return -1;
}

/** Which billing dimension a header/cell label refers to, if any. */
export function dimensionOf(label: string): Dimension | null {
  const text = label.toLowerCase();
  if (/缓存写入|cache\s*write|写入价格|写入\s*\(/.test(text)) return 'cacheWrite';
  if (/缓存命中|缓存读取|cache\s*(read|hit)|命中缓存|命中输入/.test(text)) return 'hitInput';
  if (/输出|output|completion/.test(text)) return 'output';
  if (/输入|input|prompt|未命中/.test(text)) return 'missInput';
  return null;
}

/**
 * Vendor model name -> our catalog model id.
 *
 * Kept as an explicit table because vendor labels carry context qualifiers
 * ("grok-4.7 (< 200k prompt tokens)") that no general rule can strip safely, and a
 * wrong mapping would bill one model at another's rate.
 */
export function mapCatalogModel(rules: Array<[RegExp, string]>, vendorModel: string): string | undefined {
  for (const [pattern, catalogModel] of rules) {
    if (pattern.test(vendorModel)) return catalogModel;
  }
  return undefined;
}

/** Collapse a tier-slot pair into the shared price shape, dropping empty models. */
export function buildTiers(peak: TierSlots, offpeak: TierSlots): { peak: TierSlots; offpeak: TierSlots } {
  return { peak, offpeak };
}
