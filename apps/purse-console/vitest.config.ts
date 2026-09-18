import { defineProject } from 'vitest/config';

/**
 * The app's tsconfig keeps `jsx: preserve` for Next; Vite is told to compile JSX with the
 * automatic runtime here so the component tests render under jsdom.
 */
export default defineProject({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'purse-console',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
