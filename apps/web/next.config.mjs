/** @type {import('next').NextConfig} */
const apiOrigin = process.env.APP_URL ?? 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@mediaflow/design-tokens', '@mediaflow/shared'],
  // Keep the browser talking to a single origin during development.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
