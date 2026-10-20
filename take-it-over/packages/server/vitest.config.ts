import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
