/**
 * 站点信息（名称/副标题/主色）来自后台配置，H5 与网页端保持一致。
 * 未登录也能读，所以登录页也能显示正确的品牌名。
 */
export interface SiteConfig {
  name: string;
  tagline: string;
  brandColor: string;
  pageSize: number;
}

const FALLBACK: SiteConfig = { name: 'MediaFlow', tagline: '', brandColor: '#4F6BFF', pageSize: 10 };

let cache: SiteConfig | null = null;

export async function loadSiteConfig(): Promise<SiteConfig> {
  if (cache) return cache;
  try {
    const response = await fetch('/api/public/site-config', { cache: 'no-store' });
    if (!response.ok) return FALLBACK;
    const payload = (await response.json()) as { data?: Partial<SiteConfig> };
    cache = { ...FALLBACK, ...(payload.data ?? {}) };
    return cache;
  } catch {
    return FALLBACK;
  }
}

/** 品牌主色：只覆盖 500/600 两个最常用的层级，移动端保持轻量。 */
export function applyBrandColor(hex: string): void {
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return;
  document.documentElement.style.setProperty('--mf-color-brand-500', hex);
}
