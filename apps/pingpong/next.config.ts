import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * The second tenant's Next config (docs/second-tenant.md). Nothing here names Purse's
 * source: the app reaches the platform through `@purse/sdk` in the browser and its own
 * `src/purse` client on the server, both over HTTP.
 */

/**
 * Pin the workspace root to the monorepo.
 *
 * Next infers the root by walking up for lockfiles. Any stray lockfile above the repository
 * (an accidental `npm install` in a home directory leaves one) wins that search, and Next
 * then treats the whole of that directory as the workspace: in `next dev` it tries to watch
 * every file under it, exhausts the process's file descriptors (`Watchpack Error: EMFILE`),
 * and never finishes building the route manifest, so every route answers 404 and only
 * `/_not-found` compiles. Nothing about the repository is wrong when that happens, which
 * makes it very hard to diagnose. Naming the root removes the search.
 */
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');

const nextConfig: NextConfig = {
  outputFileTracingRoot: WORKSPACE_ROOT,
  reactStrictMode: true,
  poweredByHeader: false,
  // Lint runs once at the repository root (`pnpm lint`), against the shared config.
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages ship TypeScript source; Next compiles them alongside the app.
  transpilePackages: ['@sideout/ui', '@purse/sdk', '@purse/types', '@repo/ids', '@repo/db', '@repo/logger'],
  // postgres.js opens sockets; keep it a runtime dependency rather than a bundled one.
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
