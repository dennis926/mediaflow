import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next sets jsx=preserve; tests need the automatic runtime so JSX works without importing React.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'node',
  },
});
