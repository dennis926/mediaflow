/**
 * Counter parsing for scraped platform pages.
 *
 * Browser free on purpose: the whole metrics pipeline must be unit-testable with fixture
 * strings, so nothing in here may touch `window` or `document`.
 */

/** Suffixes the platforms append to a counter, with their multiplier. */
const UNIT_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ['千', 1_000],
  ['k', 1_000],
  ['K', 1_000],
  ['万', 10_000],
  ['萬', 10_000],
  ['w', 10_000],
  ['W', 10_000],
  ['m', 1_000_000],
  ['M', 1_000_000],
  ['亿', 100_000_000],
  ['億', 100_000_000],
]);

/** Placeholders the dashboards render when a counter is empty or hidden. */
const EMPTY_COUNTER = /^(?:--+|-|—|–|~|null|undefined|nan|n\/a|暂无|暂无数据|待更新|隐藏)$/i;

function toCounter(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? floored : null;
}

/**
 * Converts a scraped counter into a non-negative integer.
 *
 * Accepts numbers and the strings the dashboards render: `1234`, `1,234`, `1.2万`, `3.4亿`,
 * `12.5k`, `58万+`, `1.2万次播放`. Returns null when there is no usable number, which lets
 * every caller treat the metric as *absent* instead of silently storing a wrong zero.
 */
export function parseCount(raw: unknown): number | null {
  if (typeof raw === 'number') return toCounter(raw);
  if (typeof raw !== 'string') return null;

  // Drop separators and the decorations platforms add around a number.
  const cleaned = raw.replace(/[\s\u00a0\u3000,，+~～>≥]/g, '');
  if (cleaned.length === 0 || EMPTY_COUNTER.test(cleaned)) return null;
  // A leading minus is never a valid counter: refuse it instead of reading the digits after it.
  if (cleaned.startsWith('-')) return null;

  const match = /(\d+(?:\.\d+)?)([千kK万萬wWmM亿億])?/.exec(cleaned);
  if (!match) return null;

  const amount = Number(match[1]);
  const suffix = match[2];
  const multiplier = suffix === undefined ? 1 : (UNIT_MULTIPLIERS.get(suffix) ?? 1);
  return toCounter(amount * multiplier);
}
