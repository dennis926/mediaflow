import { api, loadConfig } from '../lib/api';

const METRICS_ALARM = 'mediaflow:metrics';

/** Pulls tasks that need browser-extension assisted publishing. */
async function fetchPluginTasks(): Promise<{ ok: boolean; items?: unknown[]; error?: string }> {
  const config = await loadConfig();
  if (!config.token) return { ok: false, error: '尚未登录 MediaFlow' };
  try {
    const page = await api.pluginTasks();
    return { ok: true, items: page.items };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '拉取任务失败' };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(METRICS_ALARM, { periodInMinutes: 180 });
});

/**
 * Metrics collection runs on a timer: the content script reads the numbers from the
 * platform's own data page (the operator's session) and posts them back.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== METRICS_ALARM) return;
  void chrome.storage.local.get(['metricsTargets']).then(async (values) => {
    const targets = (values.metricsTargets ?? []) as string[];
    for (const url of targets) await chrome.tabs.create({ url, active: false });
  });
});

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: unknown }, _sender, sendResponse) => {
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

  if (message?.type === 'mediaflow:report-metrics') {
    const payload = message.payload as Parameters<typeof api.reportMetrics>[0];
    void api
      .reportMetrics(payload)
      .then((result) => sendResponse({ ok: true, id: result.id }))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : '回传失败' }),
      );
    return true;
  }

  return false;
});
