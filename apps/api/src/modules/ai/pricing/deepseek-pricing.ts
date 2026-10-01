/**
 * Official price scrapers.
 *
 * Design notes:
 * - Prices are **only ever read from the vendor's own page**. No third-party
 *   aggregator is trusted for billing, because a wrong number silently corrupts
 *   every reported cost.
 * - The scrapers are tolerant: if a page is restructured the parser returns an
 *   empty list instead of guessing. Callers must treat an empty/partial result as
 *   "keep the existing price".
 * - Results carry `sourceUrl` + `fetchedAt` so the UI can show provenance.
 */

import { extractTables, parseNumber } from './html-table';

export interface PriceTierCny {
  /** Input, cache miss, CNY per million tokens. */
  input: number;
  /** Input, cache hit, CNY per million tokens. */
  cacheRead: number;
  /** Output, CNY per million tokens. */
  output: number;
}

export interface ScrapedPrice {
  model: string;
  peak: PriceTierCny;
  offpeak: PriceTierCny;
  /** Vendor's own model version label, when the page states one. */
  version?: string;
}

export interface ScrapeResult {
  provider: string;
  sourceUrl: string;
  fetchedAt: string;
  prices: ScrapedPrice[];
  /** Set when the page loaded but the layout no longer matches. */
  warning?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36';

/** Which number slot a table row feeds. */
type Dimension = 'missInput' | 'hitInput' | 'output';

interface TierSlots {
  missInput?: number;
  hitInput?: number;
  output?: number;
}

function emptyTier(slots: TierSlots): PriceTierCny {
  return {
    input: slots.missInput ?? 0,
    cacheRead: slots.hitInput ?? 0,
    output: slots.output ?? 0,
  };
}

/**
 * DeepSeek publishes a single table shaped like:
 *
 *   模型                      | deepseek-flash(1) | deepseek-v4-pro
 *   模型版本                  | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813
 *   价格(2)                   | 百万tokens输入（缓存命中）
 *   空闲时段                  | 0.02元            | 0.15元
 *   高峰时段                  | 0.04元            | 0.30元
 *   百万tokens输入（缓存未命中）
 *   空闲时段                  | 1元               | 4.5元
 *   高峰时段                  | 2元               | 9.0元
 *   百万tokens输出
 *   空闲时段                  | 4元               | 13.5元
 *   高峰时段                  | 8元               | 27.0元
 *
 * Note the inconsistency: the first dimension label sits in column 1 (next to
 * "价格(2)"), the rest sit in column 0. We therefore scan every cell of a row for
 * a dimension label rather than trusting a fixed column, and read values from
 * column 1 onward.
 */
export function parseDeepseekPricing(html: string): ScrapedPrice[] {
  const table = extractTables(html)[0];
  if (!table) return [];

  const modelRow = table.rows.find((row) => row[0] === '模型');
  if (!modelRow || modelRow.length < 2) return [];
  // "deepseek-flash(1)" -> "deepseek-flash"
  const models = modelRow
    .slice(1)
    .map((cell) => cell.replace(/\(\d+\)/g, '').trim())
    .filter(Boolean);
  if (!models.length) return [];

  const versionRow = table.rows.find((row) => row[0] === '模型版本');
  const peak: TierSlots[] = models.map(() => ({}));
  const offpeak: TierSlots[] = models.map(() => ({}));

  const dimensionOf = (label: string): Dimension | null => {
    if (!label.includes('百万') || !label.includes('token')) return null;
    if (label.includes('缓存命中')) return 'hitInput';
    if (label.includes('缓存未命中')) return 'missInput';
    if (label.includes('输出')) return 'output';
    return null;
  };

  let dimension: Dimension | null = null;

  for (const row of table.rows) {
    // 1) A row may introduce a new dimension, and (because of colspan) carry that
    //    tier's numbers in the same row — e.g. "价格(2) | 百万tokens输入（缓存命中）".
    const dimensionIndex = row.findIndex((cell) => dimensionOf(cell) !== null);
    if (dimensionIndex >= 0) {
      dimension = dimensionOf(row[dimensionIndex]);
    }
    if (!dimension) continue;

    // 2) A row carries a tier's numbers when a tier label appears anywhere in it.
    const tierIndex = row.findIndex((cell) => cell.includes('高峰时段') || cell.includes('空闲时段'));
    if (tierIndex < 0) continue;
    const tier = row[tierIndex].includes('高峰') ? peak : offpeak;

    const values = row.slice(tierIndex + 1);
    models.forEach((_model, index) => {
      const value = parseNumber(values[index] ?? '');
      if (value === null) return;
      tier[index][dimension as Dimension] = value;
    });
  }

  return models.map((model, index) => ({
    model,
    version: versionRow?.[index + 1] || undefined,
    peak: emptyTier(peak[index]),
    offpeak: emptyTier(offpeak[index]),
  }));
}

/** Fetch + parse DeepSeek's official pricing page. */
export async function scrapeDeepseek(fetchImpl: FetchLike = fetch): Promise<ScrapeResult> {
  const fetchedAt = new Date().toISOString();
  const response = await fetchImpl(DEEPSEEK_PRICING_URL, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' },
  });
  if (!response.ok) {
    throw new Error(`官方定价页返回 ${response.status}`);
  }
  const html = await response.text();
  const usable = parseDeepseekPricing(html).filter(
    (price) => price.peak.input > 0 || price.peak.output > 0 || price.offpeak.input > 0,
  );
  return {
    provider: 'deepseek',
    sourceUrl: DEEPSEEK_PRICING_URL,
    fetchedAt,
    prices: usable,
    warning: usable.length ? undefined : '页面结构可能已变化，未解析到任何价格',
  };
}
