'use client';

import { useEffect } from 'react';

/**
 * 浏览器标题跟着站点配置走（站点信息可在「设置 → 站点信息」里改）。
 * metadata 是构建期静态导出，所以这里在客户端补一次。
 */
export function SiteTitle(): null {
  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/site-config', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { data?: { name?: string; tagline?: string } } | null) => {
        const site = payload?.data;
        if (cancelled || !site?.name) return;
        document.title = site.tagline ? `${site.name} · ${site.tagline}` : site.name;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
