/**
 * Extraction primitives shared by every platform parser: JSON recovery from an HTML string,
 * a generic key search and a "label next to a number" search for pages rendered without state.
 *
 * Browser free on purpose (regex + JSON only) so parsers can be unit tested with fixture HTML.
 */
import { parseCount } from './number';

/** Key comparison that ignores the separators platforms mix in: `likeCount` / `like_count` / `like-count`. */
export function normalizeKey(key: string): string {
  return key.replace(/[_\-\s.]/g, '').toLowerCase();
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['#39', "'"],
  ['#x27', "'"],
]);

/** Decodes the handful of entities that would otherwise glue labels and numbers together. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match: string, entity: string) => {
    const named = NAMED_ENTITIES.get(entity.toLowerCase());
    if (named !== undefined) return named;
    const code = entity.startsWith('#x') || entity.startsWith('#X')
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith('#')
        ? Number.parseInt(entity.slice(1), 10)
        : Number.NaN;
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

/**
 * Visible text of an HTML document.
 * `<script>`/`<style>` bodies are dropped (they would otherwise feed JSON keys into the label
 * search) and block boundaries become newlines, which keeps "label on one line, number on the
 * next" layouts readable for `findLabeledNumbers`.
 */
export function stripHtml(html: string): string {
  const withoutBlocks = html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const withBreaks = withoutBlocks
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|span|dd|dt|em|strong|b|i|a)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks.replace(/[ \t\u00a0\u3000]+/g, ' '))
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** One JSON payload recovered from the page, plus where it came from (for debugging). */
export interface JsonSource {
  source: string;
  value: unknown;
}

/** Longest JSON literal recovered per source; anything bigger is a bundle, not page state. */
const MAX_JSON_LENGTH = 4_000_000;
/** Upper bound of recovered payloads: keeps a script-heavy page from being parsed forever. */
const MAX_JSON_SOURCES = 8;

function tryParseJson(raw: string): unknown {
  if (raw.length === 0 || raw.length > MAX_JSON_LENGTH) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Truncated or JS-flavoured payloads are expected on real pages; treat as "no JSON here".
    return null;
  }
}

/**
 * Returns the object/array literal starting at `start`, respecting strings and nesting.
 * Returns null when the text does not start with `{` or `[`, or when the literal is truncated.
 */
export function scanJsonLiteral(text: string, start: number): string | null {
  const first = text[start];
  if (first !== '{' && first !== '[') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length && index - start <= MAX_JSON_LENGTH; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Recovers the state a creator dashboard embeds in the page:
 * `<script type="application/json">` / `<script id="js-initialData" type="text/json">` bodies,
 * `window.__INITIAL_STATE__ = {...}` style globals and `var _SSR_HYDRATED_DATA = {...}` ones.
 *
 * A malformed payload is skipped, never thrown: the dashboard must survive whatever it renders.
 */
export function extractInlineJson(html: string): JsonSource[] {
  if (html.length === 0) return [];
  const sources: JsonSource[] = [];

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (sources.length >= MAX_JSON_SOURCES) return sources;
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (body.trim().length === 0) continue;
    const isJsonScript = /type\s*=\s*["'](?:application|text)\/(?:json|x-json|ld\+json)["']/i.test(attributes);
    const id = /id\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    // <script id="js-initialData" type="text/json"> is already covered by the mime check; other
    // ids are only tried when the id itself looks like an embedded data container.
    const isDataScript = id !== undefined && /(?:json|data|state|initial|preload)/i.test(id);
    if (!isJsonScript && !isDataScript) continue;
    const value = tryParseJson(body.trim());
    if (value !== null) sources.push({ source: id === undefined ? 'script[type=json]' : `script#${id}`, value });
  }

  // `window.__INITIAL_STATE__ = {...}` and friends (douyin, xiaohongshu, toutiao, baijiahao).
  const assignments: Array<{ name: string; start: number }> = [];
  for (const match of html.matchAll(/(?:window|self|globalThis)\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    assignments.push({ name: match[1] ?? 'window', start: (match.index ?? 0) + match[0].length });
  }
  // `var _SSR_HYDRATED_DATA = {...}`: only obvious state globals, to avoid matching app code.
  for (const match of html.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const name = match[1] ?? '';
    if (!/^_{1,2}[A-Za-z_]/.test(name)) continue;
    assignments.push({ name, start: (match.index ?? 0) + match[0].length });
  }

  for (const { name, start } of assignments) {
    if (sources.length >= MAX_JSON_SOURCES) break;
    const literal = scanJsonLiteral(html, start);
    if (literal === null) continue;
    const value = tryParseJson(literal);
    if (value !== null) sources.push({ source: name, value });
  }

  return sources;
}

export interface SearchOptions {
  /** Deepest object level the search descends into. */
  maxDepth?: number;
  /** Upper bound of visited nodes, so a huge state object cannot stall the page. */
  maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_NODES = 20_000;

/** Single breadth-first pass that pulls the first value of every requested key group. */
function searchObjects(
  root: unknown,
  groups: Record<string, readonly string[]>,
  convert: (candidate: unknown) => string | null,
  options: SearchOptions,
): Record<string, string> {
  const wanted = new Map<string, string>();
  for (const [group, keys] of Object.entries(groups)) {
    for (const key of keys) {
      const normalized = normalizeKey(key);
      if (!wanted.has(normalized)) wanted.set(normalized, group);
    }
  }

  const found: Record<string, string> = {};
  let remaining = Object.keys(groups).length;
  if (remaining === 0 || wanted.size === 0) return found;

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const seen = new WeakSet<object>();
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let cursor = 0;
  let visited = 0;

  // Breadth first: the shallowest match is the most specific statistics block.
  while (cursor < queue.length && visited < maxNodes) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) break;
    visited += 1;

    const { node, depth } = current;
    if (node === null || typeof node !== 'object' || depth > maxDepth) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) queue.push({ node: item, depth: depth + 1 });
      continue;
    }

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      const group = wanted.get(normalizeKey(key));
      if (group === undefined || found[group] !== undefined) continue;
      const converted = convert(value);
      if (converted === null) continue;
      found[group] = converted;
      remaining -= 1;
      if (remaining === 0) return found;
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
    }
  }

  return found;
}

/** First counter found for each key group, e.g. `{ views: ['playCount', 'viewCount'] }` → `{ views: 12000 }`. */
export function findNumbers(
  root: unknown,
  groups: Record<string, readonly string[]>,
  options: SearchOptions = {},
): Record<string, number> {
  const raw = searchObjects(
    root,
    groups,
    (candidate) => {
      const parsed = parseCount(candidate);
      return parsed === null ? null : String(parsed);
    },
    options,
  );
  const numbers: Record<string, number> = {};
  for (const [group, value] of Object.entries(raw)) numbers[group] = Number(value);
  return numbers;
}

/** First non-empty string found for each key group, e.g. `{ postId: ['noteId'] }`. */
export function findStrings(
  root: unknown,
  groups: Record<string, readonly string[]>,
  options: SearchOptions = {},
): Record<string, string> {
  return searchObjects(
    root,
    groups,
    (candidate) => {
      if (typeof candidate !== 'string') return null;
      const trimmed = candidate.trim();
      return trimmed.length === 0 ? null : trimmed.slice(0, 200);
    },
    options,
  );
}

/** Longest gap tolerated between a label and its number (covers blank lines and units). */
const LABEL_NUMBER_GAP = '[\\s\\u00a0]*[:：]?[\\s\\u00a0]*';
/** A counter as it appears in rendered text: `1,234`, `1.2万`, `58万`, `12.5k`. */
const NUMBER_TEXT = '([0-9][\\d,，.]*\\s*[千kK万萬wWmM亿億]?)';
/** Anchored form used when the number is looked up right after a label. */
const NUMBER_AFTER_LABEL = new RegExp(`^${LABEL_NUMBER_GAP}${NUMBER_TEXT}`);
/** Anchored form used for the number-first layout: the number sits right before the label. */
const NUMBER_BEFORE_LABEL = new RegExp(`${NUMBER_TEXT}[\\s\\u00a0]*(?:次|个|条|人|量)?${LABEL_NUMBER_GAP}$`);

interface LabelOccurrence<Group extends string> {
  group: Group;
  /** Where the label starts and ends, used to look on both sides of it. */
  start: number;
  end: number;
}

function labelOccurrences<Group extends string>(
  text: string,
  groups: Record<Group, readonly string[]>,
): Array<LabelOccurrence<Group>> {
  const occurrences: Array<LabelOccurrence<Group>> = [];
  // `Object.keys` only sees the group names, so this cast is the group type, not a widening.
  for (const group of Object.keys(groups) as Group[]) {
    for (const label of groups[group]) {
      if (label.length === 0) continue;
      let index = text.indexOf(label);
      while (index !== -1) {
        occurrences.push({ group, start: index, end: index + label.length });
        index = text.indexOf(label, index + label.length);
      }
    }
  }
  // Longer labels win when two of them start at the same place (`点赞量` over `点赞`).
  return occurrences.sort((left, right) => left.start - right.start || right.end - left.end);
}

/**
 * Reads the counter rendered next to every label, across all fields in one pass.
 *
 * Working on all fields together is what keeps a neighbouring counter from being misread:
 * `点赞 0 / 评论 —` must leave *comments* unknown, not report the like count as a comment count,
 * so a number already claimed by another label is never reused.
 *
 * Handles both layouts: `点赞 1.2万` / `点赞\n1.2万` / `点赞：1,234` and the number-first
 * `1.2万\n点赞`. Labels without a usable number simply stay absent.
 */
export function findLabeledNumbers<Group extends string>(
  text: string,
  groups: Record<Group, readonly string[]>,
): Partial<Record<Group, number>> {
  const found: Partial<Record<Group, number>> = {};
  if (text.length === 0) return found;

  const occurrences = labelOccurrences(text, groups);
  const claimed: Array<{ start: number; end: number }> = [];

  // Pass 1: `label <number>`, the layout every dashboard uses for the counters themselves.
  for (const occurrence of occurrences) {
    if (found[occurrence.group] !== undefined) continue;
    const match = NUMBER_AFTER_LABEL.exec(text.slice(occurrence.end));
    if (match === null) continue;
    const value = parseCount(match[1]);
    if (value === null) continue;
    found[occurrence.group] = value;
    claimed.push({ start: occurrence.end, end: occurrence.end + match[0].length });
  }

  // Pass 2: `<number> label`, only for numbers no other label has claimed.
  for (const occurrence of occurrences) {
    if (found[occurrence.group] !== undefined) continue;
    const before = text.slice(0, occurrence.start);
    const match = NUMBER_BEFORE_LABEL.exec(before);
    if (match === null) continue;
    const numberStart = before.length - match[0].length;
    if (claimed.some((span) => numberStart < span.end && span.start < occurrence.start)) continue;
    const value = parseCount(match[1]);
    if (value === null) continue;
    found[occurrence.group] = value;
  }

  return found;
}

/**
 * Extracts a platform post id from a page URL, using platform-specific patterns first and the
 * common `?id=`-style query parameters as a fallback.
 */
export function findIdInUrl(url: string, patterns: readonly RegExp[]): string | null {
  if (url.length === 0) return null;
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    const value = match?.[1]?.trim();
    if (value !== undefined && value.length > 0) return value.slice(0, 160);
  }
  return null;
}
