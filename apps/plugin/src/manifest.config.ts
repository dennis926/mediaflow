import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Branding applied to the extension manifest (and, at runtime, to the popup). */
export interface PluginBranding {
  name: string;
  description: string;
}

/** Built-in fallback: last resort when neither the JSON file nor the environment provides a value. */
export const DEFAULT_PLUGIN_BRANDING: PluginBranding = {
  name: 'MediaFlow 助手',
  description: '内容分发与矩阵运营助手：自动填充内容，人工确认发布。',
};

/** Per-deployment branding file, resolved relative to the plugin package root. */
export const PLUGIN_BRANDING_FILE = 'plugin.config.json';

/** Environment variables that override the branding file at build time. */
export const PLUGIN_BRANDING_ENV = {
  name: 'PLUGIN_NAME',
  description: 'PLUGIN_DESCRIPTION',
} as const;

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Directory of this module when the loader exposes one (ESM `import.meta.url` or CJS `__dirname`). */
function moduleDir(): string | null {
  // Vite rewrites both of these when it bundles the config; plain Node/vitest exposes them natively.
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname;
  const url: unknown = import.meta.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return dirname(fileURLToPath(url));
  } catch {
    return null;
  }
}

/**
 * Walks up from the working directory until it finds the package root, so the config is
 * found whether the build runs from apps/plugin or from the repository root.
 */
function pluginRootFromCwd(): string | null {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
      if (parsed && typeof parsed === 'object' && (parsed as { name?: unknown }).name === '@mediaflow/plugin') return dir;
    } catch {
      // No readable package.json here: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Candidate locations of the branding file. `vite build --watch`, a plain `vite build`
 * and Vitest may all run with a different working directory, so every known root is probed.
 */
function brandingFilePaths(): string[] {
  const paths = [resolve(process.cwd(), PLUGIN_BRANDING_FILE), resolve(process.cwd(), 'apps', 'plugin', PLUGIN_BRANDING_FILE)];
  const root = pluginRootFromCwd();
  if (root) paths.push(resolve(root, PLUGIN_BRANDING_FILE));
  const dir = moduleDir();
  if (dir) paths.push(resolve(dir, '..', PLUGIN_BRANDING_FILE));
  return [...new Set(paths)];
}

/** Reads the first usable branding file; a missing or malformed file is not fatal. */
function readBrandingFile(): Partial<PluginBranding> {
  for (const file of brandingFilePaths()) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      return {
        name: isFilled(record.name) ? record.name.trim() : undefined,
        description: isFilled(record.description) ? record.description.trim() : undefined,
      };
    } catch {
      // Not readable or not valid JSON: try the next candidate, then fall back to the defaults.
    }
  }
  return {};
}

/**
 * Resolves the extension branding. Precedence: environment variable > plugin.config.json > built-in default.
 * Evaluated once at load time, which is build time for the manifest and test time for Vitest.
 */
export function resolvePluginBranding(): PluginBranding {
  const fromFile = readBrandingFile();
  const envName = process.env[PLUGIN_BRANDING_ENV.name];
  const envDescription = process.env[PLUGIN_BRANDING_ENV.description];
  return {
    name: isFilled(envName) ? envName.trim() : (fromFile.name ?? DEFAULT_PLUGIN_BRANDING.name),
    description: isFilled(envDescription) ? envDescription.trim() : (fromFile.description ?? DEFAULT_PLUGIN_BRANDING.description),
  };
}

const branding = resolvePluginBranding();

export const PLATFORM_HOSTS = [
  'https://creator.xiaohongshu.com/*',
  'https://channels.weixin.qq.com/*',
  'https://zhuanlan.zhihu.com/*',
  'https://mp.toutiao.com/*',
  'https://baijiahao.baidu.com/*',
];

export const MEDIAFLOW_API_ORIGIN = 'https://auto.liangyijianye.cn/*';

export const manifestConfig = {
  manifest_version: 3 as const,
  name: branding.name,
  version: '0.1.0',
  description: branding.description,
  action: {
    default_popup: 'src/popup/index.html',
    default_title: branding.name,
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module' as const,
  },
  content_scripts: [
    {
      matches: PLATFORM_HOSTS,
      js: ['src/content/index.ts'],
      run_at: 'document_idle' as const,
    },
  ],
  // Least privilege: no cookies, no webRequest, no <all_urls>.
  permissions: ['storage', 'tabs', 'activeTab', 'alarms'],
  host_permissions: [...PLATFORM_HOSTS, MEDIAFLOW_API_ORIGIN],
};
