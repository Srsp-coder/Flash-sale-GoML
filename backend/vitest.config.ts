import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    globalTeardown: ['./tests/helpers/global-teardown.ts'],
    setupFiles: ['./tests/helpers/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    // The suite shares one PostgreSQL ledger and one Redis database. Running
    // files in parallel would make reset assertions flaky, so serialize them.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 60_000,
    testTimeout: 60_000,
    reporters: ['default'],
  },
});
