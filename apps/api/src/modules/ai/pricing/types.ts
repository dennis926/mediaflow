/**
 * Shared types for the official-price scrapers.
 *
 * Every scraper returns the same shape so the refresh task, the store and the UI
 * can treat all vendors uniformly. Two details matter for correctness:
 *
 * - `currency` is explicit. Domestic vendors publish CNY, overseas vendors publish
 *   USD. Mixing them up silently multiplies or divides a cost by the exchange rate.
 * - `peak`/`offpeak` are always both present. Vendors without time-of-day pricing
 *   set them to the same value, which keeps the billing path branch-free.
 */

/** One price tier in the vendor's own currency, per million tokens. */
export interface PriceTierCny {
  /** Input, cache miss. */
  input: number;
  /** Input, cache hit. */
  cacheRead: number;
  /** Output. */
  output: number;
  /** Cache write, when the vendor prices it separately (Anthropic does). */
  cacheWrite?: number;
}

export type PriceCurrency = 'CNY' | 'USD';

export interface ScrapedPrice {
  /** Model name exactly as the vendor publishes it (used as the snapshot key). */
  model: string;
  /**
   * Our own catalog model id, when the vendor name maps to one.
   *
   * Kept alongside `model` rather than replacing it: an unmapped vendor model must
   * still be stored and shown, otherwise a vendor rename silently empties the page.
   */
  catalogModel?: string;
  peak: PriceTierCny;
  offpeak: PriceTierCny;
  /** Currency the numbers are expressed in. */
  currency: PriceCurrency;
  /** Vendor's own version label, when the page states one. */
  version?: string;
  /** Extra qualification worth showing (context tier, long-context surcharge, ...). */
  note?: string;
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

/** Which number slot a table row feeds. */
export type Dimension = 'missInput' | 'hitInput' | 'output' | 'cacheWrite';

export interface TierSlots {
  missInput?: number;
  hitInput?: number;
  output?: number;
  cacheWrite?: number;
}

/** Collapse accumulated slots into a tier, defaulting absent dimensions to 0. */
export function tierFromSlots(slots: TierSlots): PriceTierCny {
  return {
    input: slots.missInput ?? 0,
    cacheRead: slots.hitInput ?? 0,
    output: slots.output ?? 0,
    ...(slots.cacheWrite === undefined ? {} : { cacheWrite: slots.cacheWrite }),
  };
}

/**
 * A price row is only usable if it carries a real number.
 * Used to drop rows the parser matched structurally but that hold no price.
 */
export function isUsablePrice(price: ScrapedPrice): boolean {
  return price.peak.input > 0 || price.peak.output > 0 || price.offpeak.input > 0 || price.offpeak.output > 0;
}
