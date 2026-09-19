import { defineConfig } from 'tsup';

/**
 * Bundle the service and its operational scripts into flat ESM files under `dist/`
 * (`dist/index.js` serves; `dist/migrate.js`, `dist/seed.js`, `dist/reconcile.js`,
 * `dist/purge.js` and `dist/demo-reset.js` are what the container runs, without `tsx` or
 * the TypeScript sources: `apps/purse/Dockerfile`). Workspace packages are inlined (they
 * ship as TypeScript source); third-party dependencies stay external and are installed in
 * the runtime image. The output is flat on purpose: `src/paths.ts` resolves the migrations
 * folder one directory above the running file, which holds for `src/` and `dist/` alike.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    migrate: 'scripts/migrate.ts',
    seed: 'scripts/seed.ts',
    reconcile: 'scripts/reconcile.ts',
    purge: 'scripts/purge.ts',
    'demo-reset': 'scripts/demo-reset.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@repo\//, /^@purse\//],
});
