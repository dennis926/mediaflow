/**
 * Storage contract for scheduled metric collection.
 *
 * `metricsTargets` keeps the format it always had (an array of plain creator-page URLs); object
 * entries carrying `contentId` / `socialAccountId` are accepted as well, so the numbers can be
 * attached to a MediaFlow content item when the caller knows which one it is.
 *
 * Everything read from storage goes through `normalizeMetricsSettings`, so a hand-edited or
 * half-written value degrades to the default instead of breaking the alarm.
 */

export const METRICS_TARGETS_KEY = 'metricsTargets';
export const METRICS_INTERVAL_KEY = 'metricsIntervalMinutes';

/** Three hours, unchanged from the original hard-coded alarm period. */
export const DEFAULT_METRICS_INTERVAL_MINUTES = 180;
/** Chrome refuses sub-minute alarm periods: keep the floor here so bad config cannot spin. */
export const MIN_METRICS_INTERVAL_MINUTES = 1;
export const MAX_METRICS_INTERVAL_MINUTES = 24 * 60;
export const MAX_METRICS_TARGETS = 50;

/** One creator data page to scrape, with the optional MediaFlow ids the numbers belong to. */
export interface MetricsTarget {
  url: string;
  /** MediaFlow content id (UUID); dropped when it is not a UUID, the API would reject it. */
  contentId?: string;
  /** MediaFlow social account id (UUID) the numbers come from. */
  socialAccountId?: string;
}

export interface MetricsSettings {
  /** How often the sweep runs, in minutes. */
  intervalMinutes: number;
  /** Creator pages the sweep opens, in order, without duplicates. */
  targets: MetricsTarget[];
}

// UUID v4 only: the API DTO validates `IsUUID('4')`, so anything else would be rejected as a 400.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value.trim()) ? value.trim() : null;
}

function toTarget(entry: unknown): MetricsTarget | null {
  if (typeof entry === 'string') {
    const url = httpUrl(entry);
    return url === null ? null : { url };
  }
  if (entry === null || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const url = httpUrl(record.url);
  if (url === null) return null;
  const target: MetricsTarget = { url };
  const contentId = uuid(record.contentId);
  if (contentId !== null) target.contentId = contentId;
  const socialAccountId = uuid(record.socialAccountId);
  if (socialAccountId !== null) target.socialAccountId = socialAccountId;
  return target;
}

function intervalFrom(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_METRICS_INTERVAL_MINUTES;
  return Math.min(MAX_METRICS_INTERVAL_MINUTES, Math.max(MIN_METRICS_INTERVAL_MINUTES, Math.round(parsed)));
}

/**
 * Turns whatever is stored under the metrics keys into a usable settings object:
 * unknown shapes and non-http URLs are dropped, duplicates removed, the list capped, and the
 * interval clamped into a range the alarms API accepts.
 */
export function normalizeMetricsSettings(values: Record<string, unknown>): MetricsSettings {
  const rawTargets = Array.isArray(values[METRICS_TARGETS_KEY]) ? values[METRICS_TARGETS_KEY] : [];
  const targets: MetricsTarget[] = [];
  const seen = new Set<string>();
  for (const entry of rawTargets) {
    const target = toTarget(entry);
    if (target === null) continue;
    const key = targetKey(target.url);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
    if (targets.length >= MAX_METRICS_TARGETS) break;
  }
  return { intervalMinutes: intervalFrom(values[METRICS_INTERVAL_KEY]), targets };
}

/** Comparison key for page URLs: the hash never identifies a different page, the query does. */
export function targetKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.trim().replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

/** Parses a textarea value (one URL per line, `#` starts a comment) into targets. */
export function parseTargetLines(text: string): MetricsTarget[] {
  return normalizeMetricsSettings({
    [METRICS_TARGETS_KEY]: text
      .split('\n')
      .map((line) => line.split('#')[0]?.trim() ?? '')
      .filter((line) => line.length > 0),
  }).targets;
}

/** Injectable storage surface so the module can be exercised with a stub in tests. */
export interface MetricsStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

function storageArea(): MetricsStorageArea {
  return chrome.storage.local as unknown as MetricsStorageArea;
}

export async function loadMetricsSettings(): Promise<MetricsSettings> {
  const values = await storageArea().get([METRICS_TARGETS_KEY, METRICS_INTERVAL_KEY]);
  return normalizeMetricsSettings(values);
}

/** Persists a patch and returns the normalised result, so callers can show what was stored. */
export async function saveMetricsSettings(patch: Partial<MetricsSettings>): Promise<MetricsSettings> {
  const current = await loadMetricsSettings();
  const next: MetricsSettings = {
    intervalMinutes: patch.intervalMinutes ?? current.intervalMinutes,
    targets: patch.targets ?? current.targets,
  };
  const values: Record<string, unknown> = {
    [METRICS_INTERVAL_KEY]: next.intervalMinutes,
    [METRICS_TARGETS_KEY]: next.targets,
  };
  await storageArea().set(values);
  return normalizeMetricsSettings(values);
}
