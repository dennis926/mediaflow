import type { Metadata, Viewport } from 'next';
import '@mediaflow/design-tokens/tokens.css';
import './globals.css';
import { Providers } from '../lib/providers';

export const metadata: Metadata = {
  title: 'MediaFlow · 内容分发与矩阵运营',
  description: '一次创作，多平台适配，统一排期发布',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0F172A',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
