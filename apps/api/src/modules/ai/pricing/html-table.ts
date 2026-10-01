/**
 * Minimal HTML table extraction.
 *
 * Deliberately dependency-free: the pricing pages are static server-rendered tables,
 * so a small tolerant parser beats pulling in a DOM library (AGENTS.md forbids
 * unapproved dependencies). It only needs to be good enough for `<table>` markup.
 *
 * The implementation moved to `parse-utils.ts` when more vendors were added;
 * this module stays as the stable import path.
 */

export { cellText, extractTables, parseNumber, parsePriceCell } from './parse-utils';
export type { ParsedTable } from './parse-utils';
