/**
 * Backwards-compatible re-export of the official price scrapers.
 *
 * The scrapers used to live in this file (DeepSeek only); they now live in
 * `scrapers.ts` together with the other vendors. Kept so existing imports
 * (pricing service, tests) keep resolving without a churn-heavy refactor.
 */

export {
  DEEPSEEK_PRICING_URL,
  ZHIPU_PRICING_URL,
  MOONSHOT_PRICING_URL,
  XAI_PRICING_URL,
  ANTHROPIC_PRICING_URL,
  GOOGLE_PRICING_URL,
  VOLCENGINE_PRICING_URL,
  QWEN_PRICING_URL,
  parseDeepseekPricing,
  parseZhipuPricing,
  parseMoonshotPricing,
  parseXaiPricing,
  parseAnthropicPricing,
  parseGooglePricing,
  parseVolcenginePricing,
  parseQwenPricing,
  scrapeDeepseek,
  scrapeProvider,
  findScraper,
  SCRAPERS,
  BLOCKED_SOURCES,
  type ScraperDefinition,
} from './scrapers';

export type {
  FetchLike,
  PriceCurrency,
  PriceTierCny,
  ScrapeResult,
  ScrapedPrice,
  TierSlots,
} from './types';

export { cellText, extractTables, parseNumber, parsePriceCell } from './parse-utils';
