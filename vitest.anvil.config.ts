import { defineConfig } from 'vitest/config';

// The contracts on a local anvil chain (test/anvil/globalSetup.ts): one chain
// for every file, whose clock the tests move, so files run one at a time.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/anvil/**/*.test.ts'],
    globalSetup: ['test/anvil/globalSetup.ts'],
    setupFiles: ['test/setup/unit.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
  },
});
