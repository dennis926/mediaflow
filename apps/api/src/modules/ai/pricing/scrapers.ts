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
 * - Some vendors block our egress region outright (OpenAI returns 403 from
 *   Cloudflare, Anthropic's console returns "App unavailable in region"). Those
 *   providers simply have no scraper and fall back to the catalog price; that is
 *   recorded in SCRAPER_SOURCES so the UI can say so instead of looking broken.
 */

import {
  PriceTierCny,
  ScrapeResult,
  ScrapedPrice,
  TierSlots,
  FetchLike,
  Dimension,
  tierFromSlots,
  isUsablePrice,
} from './types';
import {
  buildTiers,
  cellText,
  type ParsedTable,
  columnIndex,
  dimensionOf,
  extractMarkdownTables,
  extractTables,
  fetchPage,
  hasNumber,
  mapCatalogModel,
  numberColumnIndex,
  parseNumber,
  parsePriceCell,
} from './parse-utils';

export interface ScraperDefinition {
  provider: string;
  /** Page the prices are read from (shown in the UI as the source). */
  url: string;
  /** Parser entry point. Returns [] when the layout no longer matches. */
  parse: (body: string) => ScrapedPrice[];
  /**
   * Per-vendor header overrides.
   *
   * Google serves a different table layout (translated headers) when asked for
   * Chinese, which the parser cannot match — so it must be fetched with an English
   * Accept-Language even though the UI is Chinese.
   */
  headers?: Record<string, string>;
}

export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const ZHIPU_PRICING_URL = 'https://docs.bigmodel.cn/cn/guide/start/pricing.md';
export const MOONSHOT_PRICING_URL = 'https://platform.moonshot.cn/docs/pricing/chat.md';
export const XAI_PRICING_URL = 'https://docs.x.ai/developers/pricing';
export const ANTHROPIC_PRICING_URL = 'https://www.anthropic.com/pricing';
export const GOOGLE_PRICING_URL = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';
export const VOLCENGINE_PRICING_URL = 'https://www.volcengine.com/docs/82379/1099320';
export const QWEN_PRICING_URL = 'https://help.aliyun.com/zh/model-studio/billing-for-model-studio.md';

/** Peak windows are provider-specific; these vendors have none (flat pricing). */
const FLAT = (price: Omit<PriceTierCny, 'cacheWrite'>, cacheWrite?: number): { peak: PriceTierCny; offpeak: PriceTierCny } => {
  const tier: PriceTierCny = { ...price, ...(cacheWrite === undefined ? {} : { cacheWrite }) };
  return { peak: { ...tier }, offpeak: { ...tier } };
};

// ---------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------

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

  let dimension: ReturnType<typeof dimensionOf> = null;

  for (const row of table.rows) {
    // 1) A row may introduce a new dimension, and (because of colspan) carry that
    //    tier's numbers in the same row — e.g. "价格(2) | 百万tokens输入（缓存命中）".
    const dimensionIndex = row.findIndex((cell) => dimensionOf(cell) !== null && cell.includes('百万'));
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
      tier[index][dimension as keyof TierSlots] = value;
    });
  }

  return models.map((model, index) => ({
    model,
    peak: tierFromSlots(peak[index]),
    offpeak: tierFromSlots(offpeak[index]),
    currency: 'CNY' as const,
    version: versionRow?.[index + 1] || undefined,
  }));
}

// ---------------------------------------------------------------------------
// Zhipu (GLM)
// ---------------------------------------------------------------------------

/**
 * Zhipu's pricing page is a Mintlify markdown document with repeated tables:
 *   模型名称 | 上下文 | 输入单价（元/百万 Tokens） | 输出单价（元/百万 Tokens） | 缓存存储 | 缓存命中（元/百万 Tokens）
 * Rows are keyed by model name, but a model can appear several times when it has
 * context-length tiers (GLM-5.1 has [0,32K) and ≥32K). We keep the first
 * occurrence — the cheapest, smallest-context tier — because that is the price
 * that applies to a typical request.
 */
export function parseZhipuPricing(markdown: string): ScrapedPrice[] {
  const seen = new Map<string, ScrapedPrice>();
  for (const table of extractMarkdownTables(markdown)) {
    const headerIndex = table.rows.findIndex((row) => row.some((cell) => /输入单价/.test(cell)));
    if (headerIndex < 0) continue;
    const header = table.rows[headerIndex];
    const modelCol = columnIndex(header, /模型名称|模型/);
    const inputCol = numberColumnIndex(header, /输入单价|输入.*元/);
    const outputCol = numberColumnIndex(header, /输出单价|输出.*元/);
    const cacheCol = numberColumnIndex(header, /缓存命中/);
    if (modelCol < 0 || inputCol < 0 || outputCol < 0) continue;

    for (const row of table.rows.slice(headerIndex + 1)) {
      const name = (row[modelCol] ?? '').trim();
      if (!name || seen.has(name)) continue;
      // Skip image/video/audio models — they are billed per request, not per token.
      if (/Image|TTS|ASR|Voice|Realtime|rerank|Embedding|CogVideo|Video/i.test(name)) continue;
      const input = parsePriceCell(row[inputCol] ?? '');
      const output = parsePriceCell(row[outputCol] ?? '');
      if (input === null || output === null) continue;
      const cacheRead = cacheCol >= 0 ? (parsePriceCell(row[cacheCol] ?? '') ?? 0) : 0;
      const price = FLAT({ input, output, cacheRead });
      seen.set(name, {
        model: name,
        catalogModel: name,
        ...price,
        currency: 'CNY',
        note: /≥|≥32K|\[32K/.test(row.join(' ')) ? '大上下文档' : undefined,
      });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Moonshot (Kimi)
// ---------------------------------------------------------------------------

/**
 * Kimi's page is markdown with JSX `<DocTable columns={[...]} rows={[[...]]} />`
 * blocks. We read the `rows` arrays and pair them with the `columns` titles that
 * precede them, so the column order stays authoritative even if the vendor
 * reorders columns.
 */
export function parseMoonshotPricing(markdown: string): ScrapedPrice[] {
  const results: ScrapedPrice[] = [];
  const blocks = markdown.split(/<DocTable/).slice(1);
  for (const block of blocks) {
    const titleMatch = /columns=\{\[([\s\S]*?)\]\}/.exec(block);
    const rowsMatch = /rows=\{\[([\s\S]*?)\]\s*\}\s*\/>/.exec(block);
    if (!titleMatch || !rowsMatch) continue;
    const titles = [...titleMatch[1].matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
    if (!titles.length) continue;

    const rows: string[][] = [];
    for (const rowMatch of rowsMatch[1].matchAll(/\[([^[\]]+)\]/g)) {
      const cells = [...rowMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (cells.length) rows.push(cells);
    }

    const modelCol = columnIndex(titles, /模型/);
    // 注意顺序：「缓存未命中」必须排在「输入」之前——正则交替按从左到右取首个匹配，
    // 写成 /输入|缓存未命中/ 会让未命中列被"输入"分支先命中，取到缓存命中价。
    const inputCol = numberColumnIndex(titles, /缓存未命中|未命中/, /输入/);
    const outputCol = numberColumnIndex(titles, /输出/);
    const hitCol = numberColumnIndex(titles, /缓存命中|命中/);
    // 只取 5min 档缓存写入：它是默认档，1h 档只在显式指定 TTL 时才计费。
    const writeCol = numberColumnIndex(titles, /缓存写入.*5min|缓存写入/);
    if (modelCol < 0 || inputCol < 0 || outputCol < 0) continue;

    for (const row of rows) {
      const name = (row[modelCol] ?? '').trim();
      if (!name) continue;
      const input = parsePriceCell(row[inputCol] ?? '');
      const output = parsePriceCell(row[outputCol] ?? '');
      if (input === null || output === null) continue;
      const cacheRead = hitCol >= 0 ? (parsePriceCell(row[hitCol] ?? '') ?? 0) : 0;
      const cacheWrite = writeCol >= 0 ? (parsePriceCell(row[writeCol] ?? '') ?? 0) : undefined;
      const price = FLAT({ input, output, cacheRead }, cacheWrite);
      results.push({ model: name, catalogModel: name, ...price, currency: 'CNY' });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// xAI (Grok)
// ---------------------------------------------------------------------------

/**
 * xAI's markdown pricing table:
 *   | Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
 * Long-context variants repeat the model with "(≥ 200k prompt tokens)" and a
 * doubled price. We keep the base variant (no qualifier) so the catalog price
 * matches a normal request.
 */
export function parseXaiPricing(markdown: string): ScrapedPrice[] {
  const results: ScrapedPrice[] = [];
  for (const table of extractMarkdownTables(markdown)) {
    const headerIndex = table.rows.findIndex((row) => row.some((cell) => /Input \/ 1M/i.test(cell)));
    if (headerIndex < 0) continue;
    const header = table.rows[headerIndex];
    const modelCol = columnIndex(header, /^Model$/i);
    const inputCol = numberColumnIndex(header, /^Input/);
    const cacheCol = numberColumnIndex(header, /Cached input/i);
    const outputCol = numberColumnIndex(header, /^Output/);
    if (modelCol < 0 || inputCol < 0 || outputCol < 0) continue;

    for (const row of table.rows.slice(headerIndex + 1)) {
      const raw = (row[modelCol] ?? '').trim();
      if (!raw) continue;
      // Skip long-context duplicates and non-text models (image/video/voice).
      if (/≥|imagine|voice|speech/i.test(raw)) continue;
      const input = parsePriceCell(row[inputCol] ?? '');
      const output = parsePriceCell(row[outputCol] ?? '');
      if (input === null || output === null) continue;
      const cacheRead = cacheCol >= 0 ? (parsePriceCell(row[cacheCol] ?? '') ?? 0) : 0;
      const model = raw.replace(/\s*\(.*?\)\s*/g, '').trim();
      const price = FLAT({ input, output, cacheRead });
      results.push({ model, catalogModel: model, ...price, currency: 'USD' });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------

/**
 * Anthropic's marketing pricing page renders each model as a card with
 * `__modelName` and a series of `__priceLabel` / `__priceValue` pairs
 * ("Input" $10, "Output" $50, and under "Prompt caching": "Read"/"Write").
 *
 * The card exposes display names ("Opus 5.5"), not API ids, so the mapping table
 * below converts them to `claude-opus-5` style ids.
 */
const ANTHROPIC_MODEL_RULES: Array<[RegExp, string]> = [
  [/^Fable\s+5\.1$/i, 'claude-fable-5-1'],
  [/^Fable\s+5$/i, 'claude-fable-5'],
  [/^Opus\s+5\.5$/i, 'claude-opus-5-5'],
  [/^Opus\s+5$/i, 'claude-opus-5'],
  [/^Opus\s+4\.8$/i, 'claude-opus-4-8'],
  [/^Opus\s+4\.7$/i, 'claude-opus-4-7'],
  [/^Opus\s+4\.6$/i, 'claude-opus-4-6'],
  [/^Opus\s+4\.5$/i, 'claude-opus-4-5'],
  [/^Sonnet\s+5\.5$/i, 'claude-sonnet-5-5'],
  [/^Sonnet\s+5$/i, 'claude-sonnet-5'],
  [/^Sonnet\s+4\.6$/i, 'claude-sonnet-4-6'],
  [/^Sonnet\s+4\.5$/i, 'claude-sonnet-4-5'],
  [/^Haiku\s+4\.5$/i, 'claude-haiku-4-5'],
];

export function parseAnthropicPricing(html: string): ScrapedPrice[] {
  const results: ScrapedPrice[] = [];
  const cards = html.split(/__modelName/).slice(1);
  for (const card of cards) {
    const nameMatch = /^[^>]*>([^<]+)</.exec(card);
    const name = nameMatch?.[1]?.trim();
    if (!name) continue;
    const catalogModel = mapCatalogModel(ANTHROPIC_MODEL_RULES, name);
    if (!catalogModel) continue;

    // 注意顺序：多字标签必须排在单字标签之前。「输入」也是「输入价格」的子串，
    // 但真正会串味的是"缓存写入/缓存命中/缓存读取"都含"存"字——所以缓存类先判。
    // Anthropic 的卡片用英文单词 "Read" / "Write" 表示缓存读/写，也要认。
    const dimensionOf = (label: string): Dimension | null => {
      if (/缓存写入|cache\s*write|^write$/i.test(label)) return 'cacheWrite';
      if (/缓存(命中|读取)|cache\s*(read|hit)|^read$/i.test(label)) return 'hitInput';
      if (/输出|output/i.test(label)) return 'output';
      if (/输入|input/i.test(label)) return 'missInput';
      return null;
    };

    // 每个模型卡片内部，按文档顺序把 "标签 → 价格" 配对。
    // 先按 __priceLabel 切段，再在每段内部找该标签自己的价格：卡片里有"分组标签"
    // （"Prompt caching" 自己没有价格，只包住 Read/Write），用跨标签的非贪婪匹配会
    // 让分组标签吞掉下一个标签的价格，导致 Read 被整条跳过（缓存命中价变成 0）。
    const entries: Array<{ label: string; value: number }> = [];
    for (const segment of card.split(/__priceLabel/).slice(1)) {
      const labelMatch = /^[^>]*>([^<]+)</.exec(segment);
      if (!labelMatch) continue;
      const valueMatch = /__priceValue[^>]*>([^<]+)</.exec(segment);
      if (!valueMatch) continue;
      const value = parsePriceCell(valueMatch[1]);
      if (value === null) continue;
      entries.push({ label: labelMatch[1].trim(), value });
    }

    const read: Record<string, number> = {};
    for (const entry of entries) {
      const key = dimensionOf(entry.label);
      if (!key) continue;
      // 同名维度取第一次出现：卡片里 "Prompt caching" 分组先出现 Read/Write，
      // 随后才是顶层 Input/Output，各维度都只出现一次。
      if (key === 'missInput' && read.input === undefined) read.input = entry.value;
      else if (key === 'output' && read.output === undefined) read.output = entry.value;
      else if (key === 'hitInput' && read.cacheRead === undefined) read.cacheRead = entry.value;
      else if (key === 'cacheWrite' && read.cacheWrite === undefined) read.cacheWrite = entry.value;
    }
    if (read.input === undefined || read.output === undefined) continue;

    const price = FLAT(
      { input: read.input, output: read.output, cacheRead: read.cacheRead ?? 0 },
      read.cacheWrite,
    );
    results.push({ model: catalogModel, catalogModel, ...price, currency: 'USD', note: name });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Google (Gemini via Vertex AI)
// ---------------------------------------------------------------------------

/**
 * Google publishes several tables per tier (standard / priority / batch). We read
 * the **standard** table only, and only the "Global" region row, since that is the
 * default endpoint our adapter calls. Columns:
 *   Model | Type | Region | <=200K input | >200K input | <=200K cached input
 * Input and output live in separate rows, so we accumulate per model.
 */
export function parseGooglePricing(html: string): ScrapedPrice[] {
  const accumulated = new Map<string, { input?: number; cacheRead?: number; output?: number }>();
  const tables = extractTables(html);
  let readStandard = false;

  for (const table of tables) {
    const headerIndex = table.rows.findIndex((row) => row.some((cell) => /Price \(\/1M tokens\)/i.test(cell)));
    if (headerIndex < 0) continue;
    const header = table.rows[headerIndex];
    // Standard tier only: priority/batch tables carry a qualifier in the header.
    if (header.some((cell) => /priority|flex|batch/i.test(cell))) continue;
    // The page repeats the standard table for several sections (text, image, video).
    // Only the first one is the per-token text price list — later ones price images
    // and video, and reading them would overwrite the text rates.
    if (readStandard) continue;
    const modelCol = columnIndex(header, /^Model$/i);
    const typeCol = columnIndex(header, /^Type$/i);
    const regionCol = columnIndex(header, /^Region$/i);
    const inputCol = columnIndex(header, /Price \(\/1M tokens\)\s*<= 200K input/i);
    const cachedCol = columnIndex(header, /cached input/i);
    const outputCol = columnIndex(header, /Price \(\/1M tokens\)\s*<= 200K output/i);
    if (modelCol < 0 || typeCol < 0) continue;
    readStandard = true;

    let currentModel = '';
    for (const row of table.rows.slice(headerIndex + 1)) {
      const name = (row[modelCol] ?? '').trim();
      if (name) currentModel = name;
      if (!currentModel) continue;
      // Only the Global region, and skip the long-context columns (we read the <=200K one).
      if (regionCol >= 0 && row[regionCol] && !/global/i.test(row[regionCol])) continue;
      const type = (row[typeCol] ?? '').toLowerCase();
      // Cache the bucket under the *normalised* name so the promotional row and the
      // plain row accumulate into the same model instead of one shadowing the other.
      const model = normaliseGoogleModelName(currentModel);
      if (!model) continue;
      const bucket = accumulated.get(model) ?? {};
      if (/^input/.test(type)) {
        const value = inputCol >= 0 ? parsePriceCell(row[inputCol] ?? '') : null;
        if (value !== null && bucket.input === undefined) bucket.input = value;
        if (cachedCol >= 0) {
          const cached = parsePriceCell(row[cachedCol] ?? '');
          if (cached !== null && bucket.cacheRead === undefined) bucket.cacheRead = cached;
        }
      } else if (/output/.test(type)) {
        const value =
          (outputCol >= 0 ? parsePriceCell(row[outputCol] ?? '') : null) ??
          (inputCol >= 0 ? parsePriceCell(row[inputCol] ?? '') : null);
        if (value !== null && bucket.output === undefined) bucket.output = value;
      }
      accumulated.set(model, bucket);
    }
  }

  const results: ScrapedPrice[] = [];
  for (const [model, bucket] of accumulated) {
    if (bucket.input === undefined || bucket.output === undefined) continue;
    const price = FLAT({ input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead ?? 0 });
    results.push({ model, catalogModel: model, ...price, currency: 'USD' });
  }
  return results;
}

/**
 * Turn a Vertex table label into a catalog model id, or null when the row is not a
 * per-token text model.
 *
 * Vertex writes promotional rows as "Gemini 3.8 Flash*through December 31, 2026";
 * both that row and the plain one describe the same model, so the trailing note is
 * stripped rather than the row being dropped.
 */
function normaliseGoogleModelName(raw: string): string | null {
  // Not a per-token text model: image/audio/video/live endpoints and the bare header.
  if (/image|audio|video|live api|nano banana|imagen|veo/i.test(raw)) return null;
  const base = raw
    .replace(/\*.*$/, '') // "*through December 31, 2026"
    .replace(/starting.*$/i, '') // "starting January 1, 2027"
    .trim();
  if (!base || base.toLowerCase() === 'model') return null;
  return base.replace(/\s+/g, '-').toLowerCase();
}

// ---------------------------------------------------------------------------
// Volcengine (Doubao)
// ---------------------------------------------------------------------------

/**
 * Volcengine's doc page is a server-rendered editor table. Header:
 *   模型名称 | 条件输入长度：千 token | 输入(非音频)元/百万token | 输入(音频)元/百万token
 *   | 缓存存储元/百万token/小时 | 缓存命中(非音频)元/百万token | 缓存命中(音频)元/百万token | 输出元/百万token
 * Rows repeat per context-length tier; we keep the first (smallest context).
 */
export function parseVolcenginePricing(html: string): ScrapedPrice[] {
  const seen = new Map<string, ScrapedPrice>();
  for (const table of extractTables(html)) {
    const headerIndex = table.rows.findIndex((row) => row.some((cell) => /输入.*元\/百万token/.test(cell)));
    if (headerIndex < 0) continue;
    const header = table.rows[headerIndex];
    const modelCol = columnIndex(header, /模型名称/);
    const inputCol = columnIndex(header, /输入\(非音频\)/);
    const cacheCol = columnIndex(header, /缓存命中\(非音频\)/);
    const outputCol = columnIndex(header, /输出.*元\/百万token/);
    if (modelCol < 0 || inputCol < 0 || outputCol < 0) continue;

    for (const row of table.rows.slice(headerIndex + 1)) {
      const name = (row[modelCol] ?? '').trim();
      if (!name || seen.has(name)) continue;
      // Only text/chat models; the page also lists image/video/audio models.
      if (!/^doubao/i.test(name)) continue;
      const input = parsePriceCell(row[inputCol] ?? '');
      const output = parsePriceCell(row[outputCol] ?? '');
      if (input === null || output === null) continue;
      const cacheRead = cacheCol >= 0 ? (parsePriceCell(row[cacheCol] ?? '') ?? 0) : 0;
      const price = FLAT({ input, output, cacheRead });
      seen.set(name, { model: name, catalogModel: name, ...price, currency: 'CNY' });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Aliyun (Qwen / Bailian)
// ---------------------------------------------------------------------------

/**
 * Aliyun's billing page is a Mintlify document whose tables are written in **JSX**,
 * not HTML: cells look like `<td style={{ verticalAlign: "top" }}>24元</td>`, models
 * use `rowSpan` to span several context-length rows, and every model is repeated in
 * `<Tab>` panes — one per region, with **different prices** (Singapore is ~25% above
 * Beijing).
 *
 * So we cannot reuse the HTML or markdown table extractors, and we must select the
 * region explicitly rather than relying on document order. We read only the
 * 华北2（北京） panes, which is the endpoint our adapter calls and the one billed in
 * CNY without a cross-border surcharge.
 */
export function parseQwenPricing(markdown: string): ScrapedPrice[] {
  const seen = new Map<string, ScrapedPrice>();

  for (const table of extractJsxTables(beijingPanes(markdown))) {
    const headerIndex = table.rows.findIndex((row) => row.some((cell) => /输入单价/.test(cell)));
    if (headerIndex < 0) continue;
    const header = table.rows[headerIndex];
    const modelCol = columnIndex(header, /模型 ID|Model ID/);
    const inputCol = numberColumnIndex(header, /输入单价/);
    const outputCol = numberColumnIndex(header, /输出单价/);
    if (modelCol < 0 || inputCol < 0 || outputCol < 0) continue;

    for (const row of table.rows.slice(headerIndex + 1)) {
      // 模型单元格里常跟一句"> 更多详情参考…"，只取第一个词元作为模型名。
      const raw = (row[modelCol] ?? '').replace(/`/g, '').trim().split(/\s+/)[0];
      if (!raw || seen.has(raw)) continue;
      // 跳过非模型行（表头重复、备注行）。
      if (!/^[a-zA-Z]/.test(raw) || raw.length > 64) continue;
      // Skip third-party models resold on the platform — their vendor page is authoritative.
      if (/deepseek|kimi|glm|minimax|llama|mistral/i.test(raw)) continue;
      // Only per-token text models: the page also prices audio/TTS/vision/image/OCR
      // endpoints, and those numbers are not comparable per million tokens.
      if (/audio|tts|asr|voice|image|video|vl-|ocr|embedding|rerank|livetranslate|captioner|mt-|wan/i.test(raw)) continue;
      const input = parsePriceCell(row[inputCol] ?? '');
      const output = parsePriceCell(row[outputCol] ?? '');
      if (input === null || output === null) continue;
      // 阶梯计费：取第一档（最小上下文区间），它是典型请求实际适用的单价。
      const price = FLAT({ input, output, cacheRead: 0 });
      seen.set(raw, { model: raw, catalogModel: raw, ...price, currency: 'CNY' });
    }
  }
  return [...seen.values()];
}

/**
 * Concatenate the bodies of every 华北2（北京）tab.
 *
 * A tab body runs until the next `<Tab title=` (or the end of the document). We take
 * the union rather than only the first pane because each model section repeats the
 * whole region set, so the Beijing panes are scattered through the document.
 */
function beijingPanes(markdown: string): string {
  const markers = [...markdown.matchAll(/<Tab title="([^"]+)"/g)];
  const parts: string[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (!/北京/.test(marker[1])) continue;
    const start = (marker.index ?? 0) + marker[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index ?? markdown.length : markdown.length;
    parts.push(markdown.slice(start, end));
  }
  return parts.join('\n');
}

/**
 * Extract tables written in JSX form.
 *
 * Differences from real HTML that matter: attributes are `style={{ ... }}` (so a
 * naive `[^>]*` attribute match breaks on the `>` inside), and rows use
 * `rowSpan`/`colSpan` to share a cell across rows — which must be expanded or every
 * subsequent column shifts left and prices land in the wrong field.
 */
function extractJsxTables(body: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const tableMatches = body.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const tableHtml of tableMatches) {
    const rows: string[][] = [];
    /** Cells that continue into following rows: [rowsLeft, colIndex, text]. */
    const pending: Array<{ left: number; col: number; text: string }> = [];

    for (const rowHtml of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells: string[] = [];
      let col = 0;
      const expandPending = (): void => {
        for (const span of pending) {
          if (span.left <= 0) continue;
          if (span.col === col) {
            cells[col] = span.text;
            col += 1;
          }
        }
      };

      for (const cellHtml of rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []) {
        expandPending();
        const text = cellText(cellHtml);
        const rowSpan = Number(/\browSpan=\{(\d+)\}/.exec(cellHtml)?.[1] ?? 1);
        const colSpan = Number(/\bcolSpan=\{(\d+)\}/.exec(cellHtml)?.[1] ?? 1);
        for (let i = 0; i < colSpan; i += 1) {
          cells[col] = text;
          col += 1;
        }
        if (rowSpan > 1) {
          pending.push({ left: rowSpan - 1, col: col - colSpan, text });
        }
      }
      expandPending();
      // Decrement spans only after the row is complete.
      for (const span of pending) span.left -= 1;
      const filled = cells.filter((cell) => cell !== undefined);
      if (filled.length) rows.push(cells.map((cell) => cell ?? ''));
    }
    if (rows.length) tables.push({ rows });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Every provider we can read from the vendor's own page. */
export const SCRAPERS: ScraperDefinition[] = [
  { provider: 'deepseek', url: DEEPSEEK_PRICING_URL, parse: parseDeepseekPricing },
  { provider: 'zhipu', url: ZHIPU_PRICING_URL, parse: parseZhipuPricing },
  { provider: 'kimi', url: MOONSHOT_PRICING_URL, parse: parseMoonshotPricing },
  { provider: 'xai', url: XAI_PRICING_URL, parse: parseXaiPricing },
  { provider: 'anthropic', url: ANTHROPIC_PRICING_URL, parse: parseAnthropicPricing },
  {
    provider: 'google',
    url: GOOGLE_PRICING_URL,
    parse: parseGooglePricing,
    // 中文页会把表头翻译成中文，解析器匹配不到 → 必须用英文头抓。
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },
  { provider: 'doubao', url: VOLCENGINE_PRICING_URL, parse: parseVolcenginePricing },
  { provider: 'qwen', url: QWEN_PRICING_URL, parse: parseQwenPricing },
];

export function findScraper(provider: string): ScraperDefinition | undefined {
  return SCRAPERS.find((scraper) => scraper.provider === provider);
}

/**
 * Providers whose pages we deliberately cannot read, with the reason.
 * Surfaced in the UI so an unscrapable provider reads as "not available" rather
 * than as a broken feature.
 */
export const BLOCKED_SOURCES: Array<{ provider: string; url: string; reason: string }> = [
  {
    provider: 'openai',
    url: 'https://platform.openai.com/docs/pricing',
    reason: '官网对中国香港出口返回 403（Cloudflare 拦截），无法自动抓取，请手工改价',
  },
];

/** Fetch + parse one vendor's official pricing page. */
export async function scrapeProvider(
  provider: string,
  fetchImpl: FetchLike = fetch,
): Promise<ScrapeResult> {
  const scraper = findScraper(provider);
  if (!scraper) {
    const blocked = BLOCKED_SOURCES.find((item) => item.provider === provider);
    throw new Error(
      blocked ? `无法抓取 ${provider}：${blocked.reason}` : `暂不支持抓取 ${provider} 的官方价格`,
    );
  }

  const fetchedAt = new Date().toISOString();
  const outcome = await fetchPage(scraper.url, fetchImpl, 15_000, scraper.headers ?? {});
  if (!outcome.ok) {
    throw new Error(`${provider} 官方定价页返回 ${outcome.status}`);
  }
  // 有些站点对自动化访问返回"人机校验"页（HTTP 200 但内容是 JS 挑战/空壳）。
  // 必须显式识别，否则会被当成"页面改版"，排查时完全找错方向。
  if (isChallengePage(outcome.text)) {
    throw new Error(`${provider} 官网返回人机校验页（疑似访问频率限制），稍后重试；本次保留上一份价格`);
  }
  const usable = scraper.parse(outcome.text).filter(isUsablePrice);
  return {
    provider,
    sourceUrl: scraper.url,
    fetchedAt,
    prices: usable,
    warning: usable.length ? undefined : '页面结构可能已变化，未解析到任何价格',
  };
}

/**
 * Detect an anti-bot interstitial or JS-only shell.
 *
 * Three shapes seen in practice, all served with HTTP 200 so status cannot tell
 * them apart from a real page:
 *  1. a tiny shell computing a SHA-256 proof of work;
 *  2. an obfuscated cookie-setting script;
 *  3. a JS-only app shell (volcengine) that contains version strings but no table
 *     and no price table of any kind.
 *
 * The last case is why we test for *tables* rather than for digits: a version
 * number like "1.0.0.1016" satisfies a naive digit check.
 */
export function isChallengePage(html: string): boolean {
  // 1/2: proof-of-work or obfuscated cookie interstitials.
  if (/SHA256\(\)|this\._pad\[0\]|acw_sc__v2|jsjiami|document\.cookie\s*=\s*['"]/.test(html)) {
    return true;
  }
  // 3: no table and no markdown table row anywhere — every real pricing page we
  //    read has one or the other, so this means we got a shell, not the page.
  const hasHtmlTable = /<table/i.test(html);
  const hasMarkdownTable = /^\s*\|.*\|\s*$/m.test(html);
  if (!hasHtmlTable && !hasMarkdownTable) return true;
  return false;
}

/** Kept for backwards compatibility with existing callers/tests. */
export async function scrapeDeepseek(fetchImpl: FetchLike = fetch): Promise<ScrapeResult> {
  return scrapeProvider('deepseek', fetchImpl);
}

export { buildTiers, cellText, extractTables, hasNumber, parseNumber };
export type { PriceTierCny, ScrapeResult, ScrapedPrice };
