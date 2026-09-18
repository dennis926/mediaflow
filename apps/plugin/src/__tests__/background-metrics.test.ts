/**
 * Wiring test for the service worker: it drives the real background module with a stubbed
 * `chrome` + `fetch`, so the content-script message → `POST /api/analytics/plugin-metrics`
 * path (endpoint, headers, body, alarm period) is verified, not just the parsers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface MetricsMessage {
  type?: string;
  payload?: unknown;
}

type MessageListener = (message: MetricsMessage, sender: unknown, sendResponse: (response: unknown) => void) => unknown;

interface Harness {
  chrome: Record<string, unknown>;
  store: Record<string, unknown>;
  created: Array<{ name: string; options?: { periodInMinutes?: number; delayInMinutes?: number } }>;
  createdTabs: Array<{ url?: string; active?: boolean }>;
  removedTabs: number[];
  listeners: {
    message?: MessageListener;
    alarm?: (alarm: { name: string }) => void;
    changed?: (changes: Record<string, unknown>, area: string) => void;
  };
}

const CONTENT_ID = '3f8b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ACCOUNT_ID = '7a1b2c3d-4e5f-4a6b-9c8d-1e2f3a4b5c6d';
const DATA_URL = 'https://creator.xiaohongshu.com/new/note-manager';

function harness(overrides: Record<string, unknown> = {}): Harness {
  const store: Record<string, unknown> = {
    'mediaflow.config': { apiBase: 'https://api.example.test', token: 'test-token' },
    metricsTargets: [DATA_URL],
    metricsIntervalMinutes: 90,
    ...overrides,
  };
  const created: Harness['created'] = [];
  const createdTabs: Harness['createdTabs'] = [];
  const removedTabs: number[] = [];
  const listeners: Harness['listeners'] = {};

  const chrome: Record<string, unknown> = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: (fn: MessageListener) => {
          listeners.message = fn;
        },
      },
    },
    alarms: {
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => void) => {
          listeners.alarm = fn;
        },
      },
      get: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      create: vi.fn(async (name: string, options?: Harness['created'][number]['options']) => {
        created.push({ name, options });
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const result: Record<string, unknown> = {};
          for (const key of keys) if (key in store) result[key] = store[key];
          return result;
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        }),
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => {
          listeners.changed = fn;
        },
      },
    },
    tabs: {
      create: vi.fn(async (options: { url?: string; active?: boolean }) => {
        createdTabs.push(options);
        return { id: 42, url: options.url };
      }),
      query: vi.fn(async () => []),
      remove: vi.fn(async (tabId: number) => {
        removedTabs.push(tabId);
      }),
      sendMessage: vi.fn(async () => ({ ok: true })),
      onRemoved: { addListener: vi.fn() },
    },
  };

  return { chrome, store, created, createdTabs, removedTabs, listeners };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function fetchStub(calls: FetchCall[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: 0, message: 'ok', data: { id: 'row-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

/** Loads a fresh copy of the worker against the stubs and returns the harness. */
async function loadWorker(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const context = harness(overrides);
  vi.stubGlobal('chrome', context.chrome);
  vi.resetModules();
  await import('../background/index');
  return context;
}

function report(context: Harness, payload: unknown, sender: unknown = {}): Promise<unknown> {
  return new Promise((resolve) => {
    context.listeners.message?.({ type: 'mediaflow:metrics-collected', payload }, sender, resolve);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('service worker metric reporting', () => {
  it('posts scraped numbers to /api/analytics/plugin-metrics', async () => {
    const calls: FetchCall[] = [];
    fetchStub(calls);
    const context = await loadWorker();

    const response = await report(context, {
      url: DATA_URL,
      metrics: { platform: 'xiaohongshu', views: 12000, likes: 1234, comments: 56, shares: 12, favorites: 789, postId: 'note-1' },
    });

    expect(response).toEqual({ ok: true, id: 'row-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.test/api/analytics/plugin-metrics');
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      platform: 'xiaohongshu',
      views: 12000,
      likes: 1234,
      comments: 56,
      shares: 12,
      favorites: 789,
      postId: 'note-1',
    });
  });

  it('attaches the content and account ids configured for the target page', async () => {
    const calls: FetchCall[] = [];
    fetchStub(calls);
    const context = await loadWorker({
      metricsTargets: [{ url: DATA_URL, contentId: CONTENT_ID, socialAccountId: ACCOUNT_ID }],
    });

    await report(context, { url: DATA_URL, metrics: { platform: 'xiaohongshu', views: 1 } });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      platform: 'xiaohongshu',
      contentId: CONTENT_ID,
      socialAccountId: ACCOUNT_ID,
      views: 1,
    });
  });

  it('drops unsolicited repeats of the same numbers', async () => {
    const calls: FetchCall[] = [];
    fetchStub(calls);
    const context = await loadWorker();
    const payload = { url: DATA_URL, metrics: { platform: 'xiaohongshu', views: 12000, likes: 2 } };

    const first = await report(context, payload);
    const second = await report(context, payload);

    expect(first).toEqual({ ok: true, id: 'row-1' });
    expect(second).toMatchObject({ ok: false, skipped: true });
    expect(calls).toHaveLength(1);
  });

  it('reports the page it opened on a sweep and closes that tab afterwards', async () => {
    const calls: FetchCall[] = [];
    fetchStub(calls);
    const context = await loadWorker();

    context.listeners.alarm?.({ name: 'mediaflow:metrics' });
    await vi.waitFor(() => expect(context.createdTabs).toHaveLength(1));

    // The tab the sweep opened reports the numbers it scraped.
    const response = await report(
      context,
      { url: DATA_URL, metrics: { platform: 'xiaohongshu', views: 999, likes: 5 } },
      { tab: { id: 42, url: DATA_URL } },
    );

    expect(response).toEqual({ ok: true, id: 'row-1' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ platform: 'xiaohongshu', views: 999, likes: 5 });
    await vi.waitFor(() => expect(context.removedTabs).toEqual([42]));
  });

  it('still accepts the legacy flat payload and resolves the target from the sender tab', async () => {
    const calls: FetchCall[] = [];
    fetchStub(calls);
    const context = await loadWorker({
      metricsTargets: [{ url: DATA_URL, contentId: CONTENT_ID }],
    });

    const response = await new Promise((resolve) => {
      context.listeners.message?.(
        { type: 'mediaflow:report-metrics', payload: { platform: 'xiaohongshu', views: 321, likes: 7 } },
        { tab: { id: 7, url: DATA_URL } },
        resolve,
      );
    });

    expect(response).toEqual({ ok: true, id: 'row-1' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      platform: 'xiaohongshu',
      contentId: CONTENT_ID,
      views: 321,
      likes: 7,
    });
  });

  it('rejects payloads that carry no usable number or an unknown platform', async () => {
    const calls: FetchCall[] = [];
    fetchStub(calls);
    const context = await loadWorker();

    await expect(report(context, { url: DATA_URL, metrics: { platform: 'xiaohongshu' } })).resolves.toMatchObject({ ok: false });
    await expect(report(context, { url: DATA_URL, metrics: { platform: 'weibo', views: 5 } })).resolves.toMatchObject({ ok: false });
    await expect(report(context, null)).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('opens the configured data page in an inactive tab on each alarm tick', async () => {
    fetchStub([]);
    const context = await loadWorker();

    context.listeners.alarm?.({ name: 'mediaflow:metrics' });

    await vi.waitFor(() => expect(context.createdTabs).toHaveLength(1));
    expect(context.createdTabs[0]).toMatchObject({ url: DATA_URL, active: false });
    expect(context.created.some((alarm) => alarm.name === 'mediaflow:metrics-cleanup')).toBe(true);
  });

  it('rebuilds the alarm when the stored interval changes', async () => {
    fetchStub([]);
    const context = await loadWorker();
    // Startup applied the stored 90 minutes.
    expect(context.created.some((alarm) => alarm.options?.periodInMinutes === 90)).toBe(true);

    context.created.length = 0;
    context.store.metricsIntervalMinutes = 240;
    context.listeners.changed?.({ metricsIntervalMinutes: { oldValue: 90, newValue: 240 } }, 'local');

    await vi.waitFor(() => expect(context.created).toHaveLength(1));
    expect(context.created[0]).toMatchObject({ name: 'mediaflow:metrics', options: { periodInMinutes: 240 } });
  });

  it('ignores changes coming from a different storage area', async () => {
    fetchStub([]);
    const context = await loadWorker();
    context.created.length = 0;

    context.listeners.changed?.({ metricsTargets: { newValue: [] } }, 'sync');

    expect(context.created).toHaveLength(0);
  });
});
