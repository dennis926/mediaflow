import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiOrigin = process.env.APP_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  // Production build is served from https://auto.liangyijianye.cn/h5/
  base: process.env.NODE_ENV === 'production' ? '/h5/' : '/',
  plugins: [react()],
  server: {
    host: true,
    port: 3101,
    strictPort: true,
    // Workspace packages live outside the app root, so the dev server must be allowed to serve them.
    fs: { allow: ['../..'] },
    proxy: {
      '/api': { target: apiOrigin, changeOrigin: true },
    },
  },
  preview: { host: true, port: 3101, strictPort: true },
});
