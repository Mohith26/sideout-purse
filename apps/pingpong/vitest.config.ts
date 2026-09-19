import { defineProject } from 'vitest/config';

/**
 * One project: the domain and route tests run on Node against the `_TEST` database
 * (`fileParallelism: false`, since every database test file truncates it). The app's
 * tsconfig keeps `jsx: preserve` for Next, so Vite is told to compile JSX here.
 */
export default defineProject({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'pingpong',
    include: ['test/**/*.test.{ts,tsx}'],
    env: { NODE_ENV: 'test', LOG_LEVEL: 'error' },
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
