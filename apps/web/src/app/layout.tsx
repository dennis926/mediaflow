import type { Metadata, Viewport } from 'next';
import '@mediaflow/design-tokens/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'MediaFlow',
  description: '社交媒体内容分发与矩阵运营平台',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
