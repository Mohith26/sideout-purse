import { defineConfig } from 'tsup';

/**
 * Bundle the operational scripts (migrate, seed, demo reset) into flat ESM files under
 * `dist/` so the container runs them with plain `node` and no TypeScript sources or
 * `tsx` (`apps/sideout/Dockerfile`; the app itself is `next build`'s `.next/`), and
 * `next.config.ts` into `dist/next.config.js`, which the container serves with (`next
 * start` would otherwise need TypeScript installed to read the `.ts` config). Workspace
 * packages are inlined; third-party dependencies stay external. Flat on purpose:
 * `src/paths.ts` resolves the migrations folder relative to the app root.
 */
export default defineConfig({
  entry: {
    migrate: 'scripts/migrate.ts',
    seed: 'scripts/seed.ts',
    'demo-reset': 'scripts/demo-reset.ts',
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
