import { AdapterContext, FetchLike } from './types';

const DEFAULT_TIMEOUT_MS = 15000;

export interface HttpJsonOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

function buildUrl(base: string, query?: HttpJsonOptions['query']): string {
  if (!query) return base;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.append(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${base}${base.includes('?') ? '&' : '?'}${suffix}` : base;
}

/** Thin JSON helper so adapters stay dependency free and testable through an injected fetch. */
export async function requestJson<T>(context: AdapterContext, baseUrl: string, options: HttpJsonOptions = {}): Promise<T> {
  const doFetch: FetchLike = context.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = buildUrl(baseUrl, options.query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new PlatformApiError(`平台接口返回 HTTP ${response.status}`, response.status, parsed);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Uploads raw bytes (video/image) to a platform endpoint. */
export async function postBinary<T>(
  context: AdapterContext,
  url: string,
  file: { bytes: Uint8Array; fileName: string; contentType: string; fieldName?: string },
  extraFields: Record<string, string> = {},
): Promise<T> {
  const doFetch: FetchLike = context.fetchImpl ?? ((input, init) => fetch(input, init));
  const form = new FormData();
  form.append(file.fieldName ?? 'file', new Blob([file.bytes], { type: file.contentType }), file.fileName);
  for (const [key, value] of Object.entries(extraFields)) form.append(key, value);

  const response = await doFetch(url, { method: 'POST', body: form });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T) : (null as T);
  if (!response.ok) throw new PlatformApiError(`上传接口返回 HTTP ${response.status}`, response.status, parsed);
  return parsed;
}
