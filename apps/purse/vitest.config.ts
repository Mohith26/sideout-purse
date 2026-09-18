import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'purse',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Tests share one test database; run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
