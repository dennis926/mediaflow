/** @type {import('next').NextConfig} */
const apiOrigin = process.env.APP_URL ?? 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@mediaflow/design-tokens', '@mediaflow/shared'],
  // Pages must never be cached by nginx/CDN/browser, otherwise a deploy keeps showing the old UI.
  // Hashed build assets are immutable and can be cached forever.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },

  // Keep the browser talking to a single origin during development.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
