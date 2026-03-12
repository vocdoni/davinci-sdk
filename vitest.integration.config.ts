import { defineConfig } from 'vitest/config';
import { getIntegrationTimeoutMs, loadIntegrationEnv } from './test/helpers/integrationEnv';

loadIntegrationEnv();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/integration/**/*.test.ts'],
    setupFiles: ['test/setup/integration.setup.ts'],
    testTimeout: getIntegrationTimeoutMs(),
    hookTimeout: getIntegrationTimeoutMs(),
    maxWorkers: 1,
    maxConcurrency: 1,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
