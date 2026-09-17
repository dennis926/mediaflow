import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The file shipped next to apps/plugin/package.json. */
const brandingFile = fileURLToPath(new URL('../../plugin.config.json', import.meta.url));

interface BrandingFile {
  name: string;
  description: string;
}

function readBrandingFile(): BrandingFile {
  return JSON.parse(readFileSync(brandingFile, 'utf8')) as BrandingFile;
}

/** Minimal chrome.storage stub: the api layer reads the stored apiBase before every request. */
function chromeStub(): unknown {
  return {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('插件品牌配置（manifest）', () => {
  it('builds the manifest name and description from plugin.config.json', async () => {
    const { manifestConfig } = await import('../manifest.config');
    const file = readBrandingFile();
    expect(manifestConfig.name).toBe(file.name);
    expect(manifestConfig.description).toBe(file.description);
    expect(manifestConfig.action.default_title).toBe(file.name);
  });

  it('lets PLUGIN_NAME and PLUGIN_DESCRIPTION override the config file', async () => {
    vi.stubEnv('PLUGIN_NAME', '测试品牌');
    vi.stubEnv('PLUGIN_DESCRIPTION', '测试说明');
    const { manifestConfig } = await import('../manifest.config');
    expect(manifestConfig.name).toBe('测试品牌');
    expect(manifestConfig.description).toBe('测试说明');
  });

  it('ignores blank environment values and keeps the file value', async () => {
    vi.stubEnv('PLUGIN_NAME', '   ');
    const { manifestConfig } = await import('../manifest.config');
    expect(manifestConfig.name).toBe(readBrandingFile().name);
  });
});

describe('弹窗站点名（公开接口）', () => {
  it('requests the unauthenticated public site-config endpoint', async () => {
    vi.stubGlobal('chrome', chromeStub());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ code: 0, message: 'ok', data: { name: '云媒助手', tagline: '一站式内容分发' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { loadSiteBranding } = await import('../lib/api');
    await loadSiteBranding();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://auto.liangyijianye.cn/api/public/site-config');
  });

  it('renders the site name configured on the backend', async () => {
    vi.stubGlobal('chrome', chromeStub());
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, message: 'ok', data: { name: '云媒助手', tagline: '一站式内容分发' } })));

    const { loadSiteBranding } = await import('../lib/api');

    await expect(loadSiteBranding()).resolves.toEqual({ name: '云媒助手', tagline: '一站式内容分发' });
  });

  it('falls back to MediaFlow when the endpoint is unreachable', async () => {
    vi.stubGlobal('chrome', chromeStub());
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const { FALLBACK_SITE_NAME, loadSiteBranding } = await import('../lib/api');

    await expect(loadSiteBranding()).resolves.toEqual({ name: FALLBACK_SITE_NAME, tagline: expect.any(String) });
    expect(FALLBACK_SITE_NAME).toBe('MediaFlow');
  });

  it('falls back when the backend answers with an error code or an empty payload', async () => {
    vi.stubGlobal('chrome', chromeStub());
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 500, message: '服务器错误', data: null })));

    const { FALLBACK_SITE_NAME, loadSiteBranding } = await import('../lib/api');

    await expect(loadSiteBranding()).resolves.toMatchObject({ name: FALLBACK_SITE_NAME });
  });
});
