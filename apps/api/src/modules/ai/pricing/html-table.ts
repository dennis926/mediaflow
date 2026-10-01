/**
 * Minimal HTML table extraction.
 *
 * Deliberately dependency-free: the pricing pages are static server-rendered tables,
 * so a small tolerant parser beats pulling in a DOM library (AGENTS.md forbids
 * unapproved dependencies). It only needs to be good enough for `<table>` markup.
 */

export interface ParsedTable {
  rows: string[][];
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
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
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
 * Returns null when the cell has no number (e.g. "支持", "—").
 */
export function parseNumber(cell: string): number | null {
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(cell.replace(/\s/g, ''));
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}
