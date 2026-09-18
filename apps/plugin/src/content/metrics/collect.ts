/**
 * Thin DOM layer of the metrics pipeline: the only module in it that touches browser globals.
 * It reads the live page into plain strings and hands them to the pure parsers, which is what
 * makes `collectMetrics` testable with fixture HTML instead of a real dashboard.
 */
import { isMetricsDataPage, parseMetricsForUrl, type ParsedMetrics } from './parsers';

/** Everything the parsers need, already reduced to strings. */
export interface PageEnvironment {
  url: string;
  /** `document.documentElement.outerHTML`. */
  html: string;
  /** Visible text, `document.body.innerText`, used when the page embeds no state. */
  text: string;
}

/** Snapshot of the current page. Never throws: a restricted page yields empty strings. */
export function readPageEnvironment(): PageEnvironment {
  let url = '';
  let html = '';
  let text = '';
  try {
    url = window.location.href;
  } catch {
    url = '';
  }
  try {
    html = document.documentElement?.outerHTML ?? '';
  } catch {
    html = '';
  }
  try {
    text = document.body?.innerText ?? document.body?.textContent ?? '';
  } catch {
    text = '';
  }
  return { url, html, text };
}

/** Scrapes every counter the page exposes. Returns null when there is nothing to read. */
export function collectMetrics(env: PageEnvironment): ParsedMetrics | null {
  return parseMetricsForUrl(env.url, { html: env.html, text: env.text, url: env.url });
}

/**
 * Same as `collectMetrics`, but only for data pages.
 * Used by the automatic reporting path: an editor page shows no statistics, and scraping one
 * would store a half-typed draft as if it were a published post.
 */
export function collectDataPageMetrics(env: PageEnvironment): ParsedMetrics | null {
  return isMetricsDataPage(env.url) ? collectMetrics(env) : null;
}
