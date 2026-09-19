import { defineConfig } from 'tsup';

/**
 * Bundle the operational scripts (migrate, seed, reset) into flat ESM files under `dist/` so the
 * container runs them with plain `node` (`apps/pingpong/Dockerfile`), and `next.config.ts`
 * into `dist/next.config.js` for `next start`. Workspace packages are inlined; third-party
 * dependencies stay external. Flat on purpose: `src/paths.ts` resolves the migrations
 * folder relative to the app root.
 */
export default defineConfig({
  entry: {
    migrate: 'scripts/migrate.ts',
    seed: 'scripts/seed.ts',
    reset: 'scripts/reset.ts',
    'next.config': 'next.config.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@repo\//, /^@purse\//, /^@sideout\//],
});
