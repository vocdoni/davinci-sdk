import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/unit/**/*.test.ts'],
    setupFiles: ['test/setup/unit.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
