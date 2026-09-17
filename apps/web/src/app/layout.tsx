import type { Metadata, Viewport } from 'next';
import '@mediaflow/design-tokens/tokens.css';
import './globals.css';
import { tokens } from '@mediaflow/design-tokens';
import { Providers } from '../lib/providers';
import { SiteTheme } from '../components/layout/SiteTheme';

export const metadata: Metadata = {
  // 站点名可在后台配置，这里只是首屏兜底（客户端由 SiteTitle 同步）
  title: 'MediaFlow',
  description: '一次创作，多平台适配，统一排期发布',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: tokens.color.neutral[900],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <SiteTheme />
          {children}
        </Providers>
      </body>
    </html>
  );
}
