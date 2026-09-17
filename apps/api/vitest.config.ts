import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild cannot emit decorator metadata, which Nest's DI relies on; SWC can (reads tsconfig.json).
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    // Workspace packages are symlinked ESM/CJS builds; inline them so vitest transforms them.
    server: { deps: { inline: [/@mediaflow\//] } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
