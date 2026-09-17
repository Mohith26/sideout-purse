import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'sideout',
    include: ['test/**/*.test.{ts,tsx}'],
    env: { NODE_ENV: 'test', LOG_LEVEL: 'error' },
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
