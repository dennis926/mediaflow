'use client';

import { useEffect } from 'react';
import { applyBrandColor } from '../../lib/theme';

interface SiteConfigPayload {
  data?: { name?: string; tagline?: string; brandColor?: string };
}

/**
 * 站点主题：浏览器标题 + 品牌主色都取自后台配置（设置 → 站点信息）。
 * metadata 与 Design Token 都是构建期产物，这里在客户端补一次覆盖。
 */
export function SiteTheme(): null {
  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/site-config', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: SiteConfigPayload | null) => {
        if (cancelled) return;
        const site = payload?.data;
        if (!site) return;
        if (site.name) document.title = site.tagline ? `${site.name} · ${site.tagline}` : site.name;
        if (site.brandColor) applyBrandColor(site.brandColor);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
