import { api, loadConfig, type PluginMetricsPayload } from '../lib/api';
import { MSG_COLLECT_NOW, MSG_METRICS_COLLECTED } from '../lib/messages';
import {
  METRICS_INTERVAL_KEY,
  METRICS_TARGETS_KEY,
  MIN_METRICS_INTERVAL_MINUTES,
  loadMetricsSettings,
  targetKey,
  type MetricsTarget,
} from '../lib/metrics-settings';
import { isMetricsPlatform, platformForUrl, toPlatformCode, type ParsedMetrics } from '../content/metrics/parsers';

const METRICS_ALARM = 'mediaflow:metrics';
const METRICS_CLEANUP_ALARM = 'mediaflow:metrics-cleanup';

/** Tabs opened for collection that stay silent for this long are closed again. */
const STALE_TAB_MINUTES = 10;
/** A page the operator happens to open is only reported once inside this window. */
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_DUPLICATE_ENTRIES = 200;

/** Counter names shared by the scraped metrics and the API payload. */
const METRIC_NAMES = ['views', 'likes', 'comments', 'shares', 'favorites'] as const;

/** What the content script posts: numbers plus the page they came from. */
interface MetricsReport {
  metrics: ParsedMetrics;
  url: string;
}

/** Tabs this worker opened for a sweep, so they can be closed after reporting. */
interface OwnedTab {
  url: string;
  openedAt: number;
}

/** Session storage key holding the sweep tabs, so a service-worker restart still knows them. */
const OWNED_TABS_KEY = 'mediaflow:sweepTabs';

/** Minimal view of `chrome.storage.session`, which may be missing on older Chrome builds. */
interface SessionArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

const ownedTabs = new Map<number, OwnedTab>();
const recentReports = new Map<string, number>();

function sessionArea(): SessionArea | null {
  try {
    return (chrome.storage.session as unknown as SessionArea | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Best-effort mirror of `ownedTabs`: collection works without it, tab cleanup does not. */
async function persistOwnedTabs(): Promise<void> {
  const area = sessionArea();
  if (area === null) return;
  try {
    const entries = [...ownedTabs].map(([tabId, owned]) => ({ tabId, url: owned.url, openedAt: owned.openedAt }));
    await area.set({ [OWNED_TABS_KEY]: entries });
  } catch {
    // Session storage is unavailable: the map stays in-memory for this worker's lifetime.
  }
}

/**
 * Rebuilds `ownedTabs` after a service-worker restart.
 * Without it, a data page that finishes loading after the worker was suspended would be
 * reported but its tab would never be closed again.
 */
async function restoreOwnedTabs(): Promise<void> {
  const area = sessionArea();
  if (area === null) return;
  try {
    const values = await area.get([OWNED_TABS_KEY]);
    const entries = values[OWNED_TABS_KEY];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const { tabId, url, openedAt } = record;
      if (typeof tabId !== 'number' || typeof url !== 'string' || typeof openedAt !== 'number') continue;
      ownedTabs.set(tabId, { url, openedAt });
    }
  } catch {
    // Nothing restored: the next sweep opens fresh tabs.
  }
}

async function fetchPluginTasks(): Promise<{ ok: boolean; items?: unknown[]; error?: string }> {
  const config = await loadConfig();
  if (!config.token) return { ok: false, error: '尚未登录：请先在插件里配置接口地址与访问令牌' };
  try {
    const page = await api.pluginTasks();
    return { ok: true, items: page.items };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '拉取任务失败' };
  }
}

/* ---------------------------------------------------------------- metrics sweep --- */

/**
 * (Re)creates the collection alarm from the stored settings.
 * Called on install, on browser start, whenever the settings change, and once per
 * service-worker start — an MV3 worker is stopped between sweeps, so stored config is the
 * only thing that survives.
 */
async function applyMetricsAlarm(): Promise<void> {
  try {
    const settings = await loadMetricsSettings();
    const periodInMinutes = Math.max(MIN_METRICS_INTERVAL_MINUTES, settings.intervalMinutes);
    const existing = await chrome.alarms.get(METRICS_ALARM);
    if (existing !== undefined && existing.periodInMinutes === periodInMinutes) return;
    await chrome.alarms.clear(METRICS_ALARM);
    await chrome.alarms.create(METRICS_ALARM, { periodInMinutes, delayInMinutes: periodInMinutes });
  } catch (error) {
    console.warn('[mediaflow] 无法创建数据回收定时器', error);
  }
}

function markReported(signature: string): void {
  recentReports.set(signature, Date.now());
  while (recentReports.size > MAX_DUPLICATE_ENTRIES) {
    const oldest = recentReports.keys().next();
    if (oldest.done === true) break;
    recentReports.delete(oldest.value);
  }
}

function wasReportedRecently(signature: string): boolean {
  const now = Date.now();
  for (const [key, at] of recentReports) {
    if (now - at > DUPLICATE_WINDOW_MS) recentReports.delete(key);
  }
  const last = recentReports.get(signature);
  return last !== undefined && now - last <= DUPLICATE_WINDOW_MS;
}

function reportSignature(report: MetricsReport): string {
  const parts: string[] = [report.metrics.platform, report.metrics.postId ?? '', report.metrics.title ?? '', targetKey(report.url)];
  for (const name of METRIC_NAMES) parts.push(String(report.metrics[name] ?? ''));
  return parts.join('|');
}

function toPayload(report: MetricsReport, target: MetricsTarget | undefined): PluginMetricsPayload {
  const payload: PluginMetricsPayload = { platform: toPlatformCode(report.metrics.platform) };
  if (report.metrics.postId !== undefined) payload.postId = report.metrics.postId.slice(0, 160);
  if (target?.contentId !== undefined) payload.contentId = target.contentId;
  if (target?.socialAccountId !== undefined) payload.socialAccountId = target.socialAccountId;
  for (const name of METRIC_NAMES) {
    const value = report.metrics[name];
    if (value !== undefined) payload[name] = value;
  }
  return payload;
}

/**
 * Validates a message payload before it reaches the API; unknown shapes are dropped.
 * Accepts the `{ metrics, url }` envelope the content script sends and the legacy flat payload
 * (`{ platform, views, … }`) an older build may still post; `fallbackUrl` (the sender tab) is
 * used for the target lookup when the payload carries no URL of its own.
 */
function asMetricsReport(payload: unknown, fallbackUrl?: string): MetricsReport | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const raw = record.metrics === undefined ? record : record.metrics;
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (!isMetricsPlatform(source.platform)) return null;

  const metrics: ParsedMetrics = { platform: source.platform };
  for (const name of METRIC_NAMES) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics[name] = Math.floor(value);
  }
  if (typeof source.postId === 'string' && source.postId.trim().length > 0) metrics.postId = source.postId.trim().slice(0, 160);
  if (METRIC_NAMES.every((name) => metrics[name] === undefined)) return null;

  const url = typeof record.url === 'string' && record.url.length > 0 ? record.url : (fallbackUrl ?? '');
  return { metrics, url };
}

async function closeOwnedTab(tabId: number): Promise<void> {
  ownedTabs.delete(tabId);
  await persistOwnedTabs();
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The operator may have closed the tab already: nothing to do.
  }
}

/** Reports one scraped page and closes the tab when this worker opened it for the sweep. */
async function handleMetricsReport(report: MetricsReport, tabId?: number): Promise<{ ok: boolean; id?: string; skipped?: boolean; error?: string }> {
  const settings = await loadMetricsSettings();
  const target = settings.targets.find((entry) => targetKey(entry.url) === targetKey(report.url));
  const scheduled = tabId !== undefined && ownedTabs.has(tabId);
  const signature = reportSignature(report);

  // A scheduled sweep reports every time (the numbers are the time series); a page the operator
  // opened by hand is only reported once per window, so browsing does not spam the API.
  if (!scheduled && wasReportedRecently(signature)) {
    return { ok: false, skipped: true, error: '相同数据刚刚已上报，已跳过' };
  }
  markReported(signature);

  try {
    const result = await api.reportMetrics(toPayload(report, target));
    // Success is silent on purpose: the stored row (and the returned id) is the audit trail.
    return { ok: true, id: result.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : '回传失败';
    console.warn('[mediaflow] 平台数据回传失败', message);
    return { ok: false, error: message };
  } finally {
    if (tabId !== undefined && scheduled) await closeOwnedTab(tabId);
  }
}

/** Best-effort removal of sweep tabs whose page never reported (login wall, timeout, …). */
async function closeStaleTabs(): Promise<void> {
  const deadline = Date.now() - STALE_TAB_MINUTES * 60 * 1000;
  for (const [tabId, owned] of [...ownedTabs]) {
    if (owned.openedAt <= deadline) await closeOwnedTab(tabId);
  }
}

async function hasOpenTab(url: string): Promise<boolean> {
  const key = targetKey(url);
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.some((tab) => typeof tab.url === 'string' && targetKey(tab.url) === key);
  } catch {
    return false;
  }
}

async function openTargetTab(target: MetricsTarget): Promise<number | null> {
  // An already-open tab (the operator's own, or a leftover) reports on its own; do not duplicate it.
  if (await hasOpenTab(target.url)) return null;
  try {
    const tab = await chrome.tabs.create({ url: target.url, active: false });
    if (typeof tab.id !== 'number') return null;
    ownedTabs.set(tab.id, { url: target.url, openedAt: Date.now() });
    await persistOwnedTabs();
    return tab.id;
  } catch (error) {
    console.warn('[mediaflow] 无法打开数据页', target.url, error);
    return null;
  }
}

/**
 * One collection round: open every configured creator data page in an inactive tab.
 * Each page reports back through `mediaflow:metrics-collected`, which this worker turns into a
 * `POST /api/analytics/plugin-metrics`.
 */
async function runMetricsSweep(): Promise<{ ok: boolean; opened: number; skipped: number }> {
  await closeStaleTabs();
  const settings = await loadMetricsSettings();
  const supported = settings.targets.filter((target) => platformForUrl(target.url) !== null);
  const skipped = settings.targets.length - supported.length;
  if (skipped > 0) console.warn('[mediaflow] 跳过不支持的平台域名，共', skipped, '个');

  const tabIds = await Promise.all(supported.map((target) => openTargetTab(target)));
  const opened = tabIds.filter((id) => id !== null).length;
  if (opened > 0) {
    try {
      await chrome.alarms.create(METRICS_CLEANUP_ALARM, { delayInMinutes: STALE_TAB_MINUTES });
    } catch {
      // A missing cleanup alarm only means a tab may linger; the next sweep closes it.
    }
  }
  return { ok: true, opened, skipped };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === METRICS_ALARM) {
    void runMetricsSweep().catch((error: unknown) => console.warn('[mediaflow] 数据回收失败', error));
    return;
  }
  if (alarm.name === METRICS_CLEANUP_ALARM) {
    void closeStaleTabs().catch(() => undefined);
  }
});

// The settings decide the period, so every path that can change them rebuilds the alarm.
chrome.runtime.onInstalled.addListener(() => {
  void applyMetricsAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void applyMetricsAlarm();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (METRICS_INTERVAL_KEY in changes || METRICS_TARGETS_KEY in changes) void applyMetricsAlarm();
});

// A sweep tab the operator closes by hand must not stay in the "owned" map until the next sweep.
chrome.tabs.onRemoved.addListener((tabId) => {
  ownedTabs.delete(tabId);
  void persistOwnedTabs();
});

void restoreOwnedTabs();
void applyMetricsAlarm();

/* -------------------------------------------------------------------- messages --- */

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: unknown }, sender, sendResponse) => {
  if (message?.type === 'mediaflow:pending-tasks') {
    void fetchPluginTasks().then(sendResponse);
    return true;
  }

  if (message?.type === 'mediaflow:fill-current') {
    const payload = message.payload as { title: string; body: string; tags: string[] } | undefined;
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId || !payload) {
        sendResponse({ ok: false, error: '未找到活动标签页' });
        return;
      }
      try {
        const result = await chrome.tabs.sendMessage(tabId, { type: 'mediaflow:fill', payload });
        sendResponse(result ?? { ok: false, error: '页面未响应' });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : '填充失败' });
      }
    });
    return true;
  }

  // Numbers scraped by the content script (scheduled sweep and pages the operator opens).
  if (message?.type === MSG_METRICS_COLLECTED) {
    const report = asMetricsReport(message.payload, sender.tab?.url);
    if (report === null) {
      sendResponse({ ok: false, error: '上报数据无效或没有可用的数值' });
      return true;
    }
    void handleMetricsReport(report, sender.tab?.id).then(sendResponse);
    return true;
  }

  // Popup: collect right now instead of waiting for the next alarm tick.
  if (message?.type === MSG_COLLECT_NOW) {
    void runMetricsSweep()
      .then(sendResponse)
      .catch((error: unknown) =>
        sendResponse({ ok: false, opened: 0, skipped: 0, error: error instanceof Error ? error.message : '数据回收失败' }),
      );
    return true;
  }

  if (message?.type === 'mediaflow:report-metrics') {
    const report = asMetricsReport(message.payload, sender.tab?.url);
    if (report === null) {
      sendResponse({ ok: false, error: '上报数据无效' });
      return true;
    }
    void handleMetricsReport(report).then(sendResponse);
    return true;
  }

  return false;
});
