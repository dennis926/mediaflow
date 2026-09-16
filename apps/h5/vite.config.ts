import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiOrigin = process.env.APP_URL ?? 'http://localhost:4000';

export default defineConfig({
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
