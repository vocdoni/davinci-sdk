import { defineConfig } from 'vitest/config';

// The live suite on the Gnosis deployment (test/e2e/README.md). Skipped unless
// DAVINCI_SDK_E2E is prepare or run; `run` runs its eight scenarios at once.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/*.test.ts'],
    setupFiles: ['test/setup/unit.setup.ts'],
    testTimeout: 60 * 60_000,
    hookTimeout: 30 * 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 8,
    disableConsoleIntercept: true,
    reporters: ['verbose'],
  },
});
