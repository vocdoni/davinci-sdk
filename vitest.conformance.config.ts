import { defineConfig } from 'vitest/config';

// The live conformance suite (test/e2e/live_conformance_*.test.ts) against one node
// and the OP Mainnet registry; skipped unless DAVINCI_CONFORMANCE=1. The files may
// run at once: the organizer's transactions take a lock in DAVINCI_CONFORMANCE_DIR.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/live_conformance_*.test.ts', 'test/e2e/conformance/*.test.ts'],
    testTimeout: 120 * 60_000,
    hookTimeout: 30 * 60_000,
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 4,
    disableConsoleIntercept: true,
    reporters: ['verbose'],
  },
});
