interface PendingTaskSummary {
  id: string;
  platform: string;
  title: string;
}

const API_BASE = 'http://api.mediaflow.internal';

/** Pulls tasks queued for browser-extension assisted publishing. */
async function fetchPendingTasks(token: string): Promise<PendingTaskSummary[]> {
  const response = await fetch(`${API_BASE}/api/publish/tasks?status=pending&mode=plugin`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Failed to load tasks: ${response.status}`);
  const payload = (await response.json()) as { data?: { items?: PendingTaskSummary[] } };
  return payload.data?.items ?? [];
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ installedAt: new Date().toISOString() });
});

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type === 'mediaflow:pending-tasks') {
    void chrome.storage.local.get(['token']).then(async (values) => {
      const token = typeof values.token === 'string' ? values.token : '';
      if (!token) {
        sendResponse({ items: [] });
        return;
      }
      try {
        sendResponse({ items: await fetchPendingTasks(token) });
      } catch (error) {
        sendResponse({ items: [], error: error instanceof Error ? error.message : 'unknown' });
      }
    });
    return true;
  }
  return false;
});
