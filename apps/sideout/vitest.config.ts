import { defineProject } from 'vitest/config';

/**
 * One project: the route and domain tests run on Node against the `_TEST` database
 * (`fileParallelism: false`, since every file truncates it), and the component tests
 * under `test/ui` opt into jsdom with a `@vitest-environment` docblock. The app's tsconfig
 * keeps `jsx: preserve` for Next, so Vite is told to compile JSX with the automatic
 * runtime here.
 */
export default defineProject({
  oxc: { jsx: { runtime: 'automatic' } },
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
