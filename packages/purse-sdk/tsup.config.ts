import { defineConfig } from 'tsup';

/**
 * The browser bundle a partner page loads: one minified ESM file with `@purse/types` and
 * its Zod schemas inlined and no other dependency. Its declarations are the ones
 * `tsc -b` emits to `dist/src` (this package's tsconfig is a composite project, which
 * tsup's own d.ts pass cannot share). Workspace consumers (Sideout, the API) keep reading
 * the TypeScript source through `exports['.']`; `exports['./bundle']` is this file, which
 * the browser smoke test loads over a plain `<script type="module">`.
 */
export default defineConfig({
  entry: { 'purse-sdk': 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  outDir: 'dist',
  sourcemap: true,
  clean: false,
  splitting: false,
  treeshake: true,
  minify: true,
  noExternal: [/^@purse\//, /^zod/],
});
