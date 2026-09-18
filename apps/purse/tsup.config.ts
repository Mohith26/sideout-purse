import { defineConfig } from 'tsup';

/**
 * Bundle the service into one ESM file. Workspace packages are inlined (they ship as
 * TypeScript source); third-party dependencies stay external and are installed in the
 * runtime image in phase 9.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@repo\//, /^@purse\//],
});
