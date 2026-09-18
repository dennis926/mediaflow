import { FillPayload } from './BasePlatformAdapter';
import { WechatVideoAdapter } from './adapters/WechatVideoAdapter';
import { XiaohongshuAdapter } from './adapters/XiaohongshuAdapter';
import { MSG_COLLECT_METRICS, MSG_METRICS_COLLECTED } from '../lib/messages';
import { collectDataPageMetrics, collectMetrics, readPageEnvironment } from './metrics/collect';
import { isMetricsDataPage, type ParsedMetrics } from './metrics/parsers';

const adapters = [new XiaohongshuAdapter(), new WechatVideoAdapter()];

function activeAdapter(url: string) {
  return adapters.find((adapter) => adapter.canHandle(url));
}

/** How often a data page is re-read while waiting for its counters to render. */
const COLLECT_ATTEMPTS = 5;
const COLLECT_INTERVAL_MS = 2000;

/** Hands the scraped numbers to the service worker, which owns the API call and the dedup. */
function reportMetrics(metrics: ParsedMetrics, url: string): void {
  void chrome.runtime.sendMessage({ type: MSG_METRICS_COLLECTED, payload: { metrics, url } }).catch(() => undefined);
}

/** Reads the current page and reports it; true when there was something to report. */
function collectAndReport(): boolean {
  const environment = readPageEnvironment();
  const metrics = collectDataPageMetrics(environment);
  if (metrics === null) return false;
  reportMetrics(metrics, environment.url);
  return true;
}

/**
 * Creator dashboards fetch their numbers after the first paint, so a data page is polled a few
 * times. Stops as soon as one round yields metrics, and never runs on editor pages.
 */
async function collectWhenRendered(): Promise<void> {
  for (let attempt = 0; attempt < COLLECT_ATTEMPTS; attempt += 1) {
    if (collectAndReport()) return;
    await new Promise((resolve) => setTimeout(resolve, COLLECT_INTERVAL_MS));
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: FillPayload }, _sender, sendResponse) => {
  // Pull path: an explicit request reads the page once, without the data-page gate.
  if (message?.type === MSG_COLLECT_METRICS) {
    const environment = readPageEnvironment();
    sendResponse({ ok: true, url: environment.url, metrics: collectMetrics(environment) });
    return true;
  }

  if (message?.type !== 'mediaflow:fill' || !message.payload) return false;
  const adapter = activeAdapter(window.location.href);
  if (!adapter) {
    sendResponse({ ok: false, message: '当前页面不在支持的平台编辑器内' });
    return true;
  }
  const report = adapter.fill(document, message.payload);
  sendResponse({ ok: true, platform: adapter.platform, report });
  return true;
});

// Let the popup know a supported editor is open so it can enable the fill button.
void chrome.runtime
  .sendMessage({ type: 'mediaflow:adapter-ready', platform: activeAdapter(window.location.href)?.platform ?? null })
  .catch(() => undefined);

// Scheduled collection lands here: the background opens the data page, this script reads it.
if (isMetricsDataPage(window.location.href)) void collectWhenRendered();
