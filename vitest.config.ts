import { defineConfig } from 'vitest/config';

/**
 * One Vitest run, one project per package. Each project keeps its own environment (the
 * two apps each migrate their own `_TEST` database in a global setup); the `repo` project
 * holds the tests about the repository itself: the boundary lint rule and env isolation.
 */
export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      {
        test: {
          name: 'repo',
          root: import.meta.dirname,
          include: ['test/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
    reporters: process.env['CI'] ? ['default', 'github-actions'] : ['default'],
  },
});
