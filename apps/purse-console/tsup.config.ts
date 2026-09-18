import { defineConfig } from 'tsup';

/**
 * Compile `next.config.ts` into `dist/next.config.js`, which the container serves with:
 * `next start` would otherwise need TypeScript installed to read the `.ts` config
 * (`apps/purse-console/Dockerfile`). Nothing else of the console is bundled here; the app
 * itself is `next build`'s `.next/`.
 */
export default defineConfig({
  entry: { 'next.config': 'next.config.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
});
