/**
 * Per-platform metric parsers for the creator dashboards.
 *
 * Two extraction paths, in this order:
 *   1. the state the page embeds (`<script type="application/json">`, `window.__INITIAL_STATE__`, …)
 *   2. the rendered labels (`点赞 1.2万`), which is what survives when a dashboard is client rendered
 *
 * Everything here is a pure function of strings: no `window`, no `document`. That is what makes
 * `src/__tests__/metrics-parse.test.ts` able to exercise a real page shape without a browser.
 *
 * Failures are swallowed on purpose — a scraping bug must never break the operator's page, so the
 * worst case is "no metrics this round" (null) instead of an exception.
 */
import type { PlatformCode } from '@mediaflow/shared';
import { extractInlineJson, findIdInUrl, findLabeledNumbers, findNumbers, findStrings, stripHtml, type JsonSource } from './extract';

/**
 * Platform codes this scraper knows about.
 * A plain string union (not the enum) so parsers stay literal-friendly; `PLATFORM_MIRROR` checks
 * every name against the shared `PlatformCode` enum at compile time.
 */
export type MetricsPlatform = 'douyin' | 'xiaohongshu' | 'wechat_video' | 'wechat_mp' | 'zhihu' | 'toutiao' | 'baijiahao';

/**
 * Local name → shared enum value. The mapped type pins every value to the enum's string values,
 * so a name the backend does not accept fails `tsc`, not the API call.
 */
const PLATFORM_MIRROR: Record<MetricsPlatform, `${PlatformCode}`> = {
  douyin: 'douyin',
  xiaohongshu: 'xiaohongshu',
  wechat_video: 'wechat_video',
  wechat_mp: 'wechat_mp',
  zhihu: 'zhihu',
  toutiao: 'toutiao',
  baijiahao: 'baijiahao',
};

/**
 * Bridges the local union to the shared enum for the API payload.
 * This is the only cast in the metrics pipeline: the strings are identical, TypeScript just
 * refuses to widen a string literal into a string enum without one.
 */
export function toPlatformCode(platform: MetricsPlatform): PlatformCode {
  return PLATFORM_MIRROR[platform] as PlatformCode;
}

/** The five counters MediaFlow stores for every platform. */
export type MetricField = 'views' | 'likes' | 'comments' | 'shares' | 'favorites';

export const METRIC_FIELDS: readonly MetricField[] = ['views', 'likes', 'comments', 'shares', 'favorites'];

/** Numbers read off one platform page. Absent keys mean "not found", never "zero". */
export interface ParsedMetrics {
  platform: MetricsPlatform;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  favorites?: number;
  /** Post title; used for logs and duplicate detection only — the API payload has no title slot. */
  title?: string;
  postId?: string;
}

export interface MetricParseInput {
  /** Page HTML: `document.documentElement.outerHTML` on a live page, a fixture string in tests. */
  html?: string;
  /** Visible page text when the caller already has it (`document.body.innerText`). */
  text?: string;
  /** Page URL, used to derive the platform and, when possible, the post id. */
  url?: string;
}

export interface MetricsPlatformSpec {
  platform: MetricsPlatform;
  /** Hosts whose pages carry the numbers; also used to decide which target URLs are worth opening. */
  hosts: readonly string[];
  /** Path fragments that mark a data page (as opposed to an editor page). */
  dataPath: RegExp;
  /** Path fragments of the authoring UI: never scraped, the numbers there mean something else. */
  editorPath: RegExp;
  /** Platform specific JSON keys, searched before the shared list. */
  jsonKeys: Partial<Record<MetricField, readonly string[]>>;
  /** Labels the dashboard renders next to each counter. */
  labels: Partial<Record<MetricField, readonly string[]>>;
  postIdKeys: readonly string[];
  titleKeys: readonly string[];
  /** URL patterns yielding the post id, most specific first. */
  idPatterns: readonly RegExp[];
}

/** Key names shared by most dashboards (English camelCase, snake_case and pinyin variants). */
const SHARED_JSON_KEYS: Record<MetricField, readonly string[]> = {
  views: [
    'viewCount',
    'playCount',
    'readCount',
    'viewNum',
    'showCount',
    'impressionCount',
    'exposureCount',
    'watchCount',
    'readNum',
    'playNum',
    'clickCount',
    'pv',
  ],
  likes: ['likeCount', 'likeNum', 'diggCount', 'praiseCount', 'upCount', 'thumbUpCount', 'oldLikeNum'],
  comments: ['commentCount', 'commentNum', 'replyCount', 'commentCnt'],
  shares: ['shareCount', 'shareNum', 'forwardCount', 'repostCount', 'transmitCount', 'shareCnt'],
  favorites: ['collectCount', 'collectNum', 'favoriteCount', 'favoriteNum', 'favCount', 'collectCnt'],
};

/**
 * Rendered labels, longest first so `播放量` wins over `播放` when both appear.
 * Resolved by `findLabeledNumbers`, which claims the numbers of all fields in one pass.
 */
const SHARED_LABELS: Record<MetricField, readonly string[]> = {
  views: ['播放量', '播放数', '播放', '观看量', '观看', '阅读量', '阅读数', '阅读', '展现量', '展现', '曝光量', '曝光', '浏览量', '浏览'],
  likes: ['点赞量', '点赞数', '点赞', '赞', '喜欢'],
  comments: ['评论量', '评论数', '评论'],
  shares: ['分享量', '分享数', '分享', '转发量', '转发数', '转发'],
  favorites: ['收藏量', '收藏数', '收藏'],
};

/** Query parameters that carry a post id on most creator pages. */
const QUERY_ID = /[?&](?:postId|noteId|itemId|articleId|objectId|contentId|appmsgid|msgid|id)=([A-Za-z0-9_-]{2,64})/i;

/** Adds the website's own hostname to a host list (creator.<site> plus <site>). */
const HOSTS = (host: string): string[] => [host];

const SPECS: readonly MetricsPlatformSpec[] = [
  {
    platform: 'douyin',
    hosts: HOSTS('creator.douyin.com'),
    dataPath: /(?:data|content|statistic|analytics|analysis|home|works|manage|video)/i,
    editorPath: /(?:\/publish|create|upload|edit|write)/i,
    jsonKeys: { views: ['playCount', 'playNum'], likes: ['diggCount'], shares: ['shareCount'] },
    labels: { views: ['播放量', '播放'], likes: ['点赞'], comments: ['评论'], shares: ['分享'], favorites: ['收藏'] },
    postIdKeys: ['awemeId', 'itemId', 'groupId', 'awemeIdStr'],
    titleKeys: ['title', 'desc', 'itemTitle', 'awemeName'],
    idPatterns: [/\/video\/(\d{6,})/i, /\/item\/(\d{6,})/i, QUERY_ID],
  },
  {
    platform: 'xiaohongshu',
    hosts: HOSTS('creator.xiaohongshu.com'),
    dataPath: /(?:note-manager|statistic|analytics|data|dashboard|content|home|manage)/i,
    editorPath: /(?:\/publish|create|upload|edit|write)/i,
    jsonKeys: { views: ['viewCount', 'viewNum'], likes: ['likedCount', 'likeCount'], favorites: ['collectedCount', 'collectCount'] },
    labels: { views: ['观看量', '观看', '浏览量', '浏览'], likes: ['点赞'], comments: ['评论'], shares: ['分享'], favorites: ['收藏'] },
    postIdKeys: ['noteId', 'note_id', 'notesId'],
    titleKeys: ['title', 'noteTitle', 'displayTitle'],
    idPatterns: [/[?&]noteId=([A-Za-z0-9]{8,})/i, /\/note\/([A-Za-z0-9]{8,})/i, QUERY_ID],
  },
  {
    platform: 'wechat_video',
    hosts: HOSTS('channels.weixin.qq.com'),
    dataPath: /(?:statistic|data|dashboard|analysis|platform\/post|home|content)/i,
    editorPath: /(?:\/create|edit|publish|write|upload)/i,
    jsonKeys: { views: ['playCount', 'readCount', 'exposureCount'], likes: ['likeCount', 'favCount'] },
    labels: { views: ['播放量', '播放', '观看量'], likes: ['点赞'], comments: ['评论'], shares: ['分享', '转发'], favorites: ['收藏'] },
    postIdKeys: ['objectId', 'exportId', 'videoId', 'objectNonceId'],
    titleKeys: ['title', 'description', 'desc'],
    idPatterns: [/\/(?:post|video)\/([A-Za-z0-9_-]{6,})/i, QUERY_ID],
  },
  {
    platform: 'wechat_mp',
    hosts: HOSTS('mp.weixin.qq.com'),
    dataPath: /(?:appmsg|statistic|data|analysis|home|content)/i,
    editorPath: /(?:\/cgi-bin\/appmsg|edit|write|publish|upload)/i,
    jsonKeys: { views: ['readNum', 'readCount', 'targetNum', 'viewCount'], likes: ['likeNum', 'oldLikeNum', 'likeCount'], favorites: ['watchingCount', 'favoriteCount'] },
    labels: { views: ['阅读量', '阅读'], likes: ['点赞'], comments: ['评论', '留言'], shares: ['分享', '转发'], favorites: ['在看', '收藏'] },
    postIdKeys: ['appmsgid', 'appMsgId', 'msgid', 'msgId'],
    titleKeys: ['title', 'appmsgTitle'],
    idPatterns: [/[?&]appmsgid=(\d+)/i, QUERY_ID],
  },
  {
    platform: 'zhihu',
    hosts: HOSTS('zhuanlan.zhihu.com'),
    dataPath: /(?:creator|analysis|statistic|data|dashboard|content)/i,
    editorPath: /(?:\/write|\/edit|publish|upload|create)/i,
    jsonKeys: { views: ['readCount', 'viewCount', 'pv'], likes: ['likeCount', 'voteUpCount'] },
    labels: { views: ['阅读量', '阅读'], likes: ['赞同', '点赞'], comments: ['评论'], shares: ['分享'], favorites: ['收藏'] },
    postIdKeys: ['articleId', 'id'],
    titleKeys: ['title'],
    idPatterns: [/\/p\/(\d{5,})/i, /[?&]articleId=(\d+)/i, QUERY_ID],
  },
  {
    platform: 'toutiao',
    hosts: HOSTS('mp.toutiao.com'),
    dataPath: /(?:statistic|analytics|data|dashboard|analysis|profile_v4|content|home)/i,
    editorPath: /(?:\/publish|\/edit|create|upload|write)/i,
    jsonKeys: { views: ['showCount', 'showNum'], shares: ['forwardCount'], favorites: ['favoriteCount'] },
    labels: { views: ['展现量', '展现', '阅读量', '阅读', '播放量'], likes: ['点赞'], comments: ['评论'], shares: ['转发', '分享'], favorites: ['收藏'] },
    postIdKeys: ['itemId', 'groupId', 'articleId', 'id'],
    titleKeys: ['title', 'articleTitle'],
    idPatterns: [/\/article\/(\d{6,})/i, /[?&]item_id=(\d+)/i, QUERY_ID],
  },
  {
    platform: 'baijiahao',
    hosts: HOSTS('baijiahao.baidu.com'),
    dataPath: /(?:builder\/rc|statistic|data|dashboard|analysis|content|home)/i,
    editorPath: /(?:\/edit|publish|create|upload|write)/i,
    jsonKeys: { views: ['viewCount', 'readCount', 'clickCount'], shares: ['shareCount'] },
    labels: { views: ['阅读量', '阅读', '播放量'], likes: ['点赞'], comments: ['评论'], shares: ['分享', '转发'], favorites: ['收藏'] },
    postIdKeys: ['articleId', 'itemId', 'id'],
    titleKeys: ['title'],
    idPatterns: [/[?&]id=(\d{6,})/i, /\/content\/(\d{6,})/i, QUERY_ID],
  },
];

interface PreparedSpec {
  spec: MetricsPlatformSpec;
  /** JSON key groups merged with the shared list, ready for a single object search. */
  groups: Record<MetricField, readonly string[]>;
  /** Label groups merged with the shared list, longest labels first. */
  labels: Record<MetricField, readonly string[]>;
}

function mergeKeys(spec: MetricsPlatformSpec, shared: Record<MetricField, readonly string[]>): Record<MetricField, readonly string[]> {
  return {
    views: [...(spec.jsonKeys.views ?? []), ...shared.views],
    likes: [...(spec.jsonKeys.likes ?? []), ...shared.likes],
    comments: [...(spec.jsonKeys.comments ?? []), ...shared.comments],
    shares: [...(spec.jsonKeys.shares ?? []), ...shared.shares],
    favorites: [...(spec.jsonKeys.favorites ?? []), ...shared.favorites],
  };
}

function mergeLabels(spec: MetricsPlatformSpec): Record<MetricField, readonly string[]> {
  const labels = (field: MetricField): readonly string[] => {
    const specific = spec.labels[field] ?? [];
    const shared = SHARED_LABELS[field].filter((label) => !specific.includes(label));
    return [...specific, ...shared].sort((left, right) => right.length - left.length);
  };
  return { views: labels('views'), likes: labels('likes'), comments: labels('comments'), shares: labels('shares'), favorites: labels('favorites') };
}

const PREPARED: readonly PreparedSpec[] = SPECS.map((spec) => ({
  spec,
  groups: mergeKeys(spec, SHARED_JSON_KEYS),
  labels: mergeLabels(spec),
}));

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const match = /^https?:\/\/([^/?#]+)/i.exec(url);
    if (!match) return null;
    const host = match[1];
    return host === undefined ? null : host.toLowerCase().split(':')[0] ?? null;
  }
}

/** Path and query of a URL, so data/editor checks never look at the hostname. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.replace(/^https?:\/\/[^/]*/i, '');
  }
}

/** Platform spec for a page URL, or null when the host is not one we scrape. */
export function specForUrl(url: string): MetricsPlatformSpec | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const hostname = hostnameOf(url);
  if (hostname === null) return null;
  for (const spec of SPECS) {
    if (spec.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return spec;
  }
  return null;
}

/** Platform spec by code, or null for platforms without a scraper. */
export function specForPlatform(platform: string): MetricsPlatformSpec | null {
  return SPECS.find((spec) => spec.platform === platform) ?? null;
}

/** Runtime guard for platform names arriving from a message or a page. */
export function isMetricsPlatform(value: unknown): value is MetricsPlatform {
  return typeof value === 'string' && SPECS.some((spec) => spec.platform === value);
}

/** Platform whose dashboard the URL belongs to, or null. */
export function platformForUrl(url: string): MetricsPlatform | null {
  return specForUrl(url)?.platform ?? null;
}

/** All hosts the scraper understands; used for diagnostics and by the sweep filter. */
export function metricsHosts(): string[] {
  return [...new Set(SPECS.flatMap((spec) => spec.hosts))];
}

/**
 * True when the URL is a *data* page (numbers) rather than an authoring page (editor).
 * The content script only reports from data pages: scraping an editor would store nonsense.
 */
export function isMetricsDataPage(url: string): boolean {
  const spec = specForUrl(url);
  if (spec === null) return false;
  const path = pathOf(url);
  return spec.dataPath.test(path) && !spec.editorPath.test(path);
}

function metricsFromSources(group: Record<MetricField, readonly string[]>, sources: readonly JsonSource[]): Partial<Record<MetricField, number>> {
  const numbers: Partial<Record<MetricField, number>> = {};
  for (const source of sources) {
    const found = findNumbers(source.value, group);
    for (const field of METRIC_FIELDS) {
      const value = found[field];
      if (numbers[field] === undefined && value !== undefined) numbers[field] = value;
    }
    if (METRIC_FIELDS.every((field) => numbers[field] !== undefined)) break;
  }
  return numbers;
}

function parseWithSpec(prepared: PreparedSpec, input: MetricParseInput): ParsedMetrics | null {
  const { spec } = prepared;
  const html = typeof input.html === 'string' ? input.html : '';
  const providedText = typeof input.text === 'string' ? input.text : '';
  const text = providedText.trim().length > 0 ? providedText : stripHtml(html);
  if (html.length === 0 && text.length === 0) return null;

  const sources = extractInlineJson(html);
  const numbers = metricsFromSources(prepared.groups, sources);

  // Whatever the embedded state did not provide is looked up in the rendered labels.
  // All fields are resolved in one pass so a neighbour's counter cannot be misread as this one's.
  const labeled = findLabeledNumbers(text, prepared.labels);
  for (const field of METRIC_FIELDS) {
    if (numbers[field] !== undefined) continue;
    const value = labeled[field];
    if (value !== undefined) numbers[field] = value;
  }

  const metrics: ParsedMetrics = { platform: spec.platform };
  for (const field of METRIC_FIELDS) {
    const value = numbers[field];
    if (value !== undefined) metrics[field] = value;
  }

  const url = typeof input.url === 'string' ? input.url : '';
  const postId = findIdInUrl(url, spec.idPatterns) ?? findStrings(sources, { postId: spec.postIdKeys }).postId ?? null;
  if (postId !== null) metrics.postId = postId.slice(0, 160);
  const title = findStrings(sources, { title: spec.titleKeys }).title;
  if (title !== undefined) metrics.title = title.slice(0, 160);

  // A page that yields no counter at all is reported as "nothing scraped" rather than as zeros:
  // storing zeros would silently wipe a real reading in the analytics table.
  return METRIC_FIELDS.some((field) => metrics[field] !== undefined) ? metrics : null;
}

/** Parses one platform's page. Returns null when no counter could be read; never throws. */
export function parseMetrics(platform: string, input: MetricParseInput = {}): ParsedMetrics | null {
  const spec = specForPlatform(platform);
  if (spec === null) return null;
  const prepared = PREPARED.find((entry) => entry.spec === spec);
  if (prepared === undefined) return null;
  try {
    return parseWithSpec(prepared, input);
  } catch {
    // Defensive: a parser bug degrades to "no metrics this round", it never breaks the page.
    return null;
  }
}

/** Picks the platform from the URL and parses the page. Returns null for unsupported hosts. */
export function parseMetricsForUrl(url: string, input: MetricParseInput = {}): ParsedMetrics | null {
  const platform = platformForUrl(url);
  if (platform === null) return null;
  return parseMetrics(platform, { ...input, url: input.url ?? url });
}
