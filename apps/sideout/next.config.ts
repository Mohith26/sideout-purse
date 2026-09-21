import path from 'node:path';

import type { NextConfig } from 'next';

import { switchFrom } from './src/lib/switch';

/**
 * Route files Next recognises. `route.dev.ts` files (today: `POST /api/dev/login`) are
 * routes only when `dev.ts` is listed, and it is listed only outside production, so a
 * production build has no such route at all rather than a disabled one.
 * `test/auth/dev-login.test.ts` proves the extension list; phase 9 checks the production
 * build's route manifest (docs/decisions.md).
 */
export function pageExtensionsFor(nodeEnv: string | undefined): string[] {
  return nodeEnv === 'production' ? ['ts', 'tsx'] : ['dev.ts', 'ts', 'tsx'];
}

/**
 * `NEXT_PUBLIC_DEMO_ACCOUNTS` follows `DEMO_ACCOUNTS` (`docs/demo-accounts.md`): derived here
 * at build time, inlined into both bundles by the `env` block below, and compared with the
 * runtime `DEMO_ACCOUNTS` by `src/env.ts`, which refuses to boot a build made for the other
 * setting. `apps/sideout/Dockerfile` passes `DEMO_ACCOUNTS` through as a build argument.
 */
export function demoAccountsFor(demoAccounts: string | undefined): 'true' | 'false' {
  return switchFrom(demoAccounts) ? 'true' : 'false';
}


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
  pageExtensions: pageExtensionsFor(process.env.NODE_ENV),
  env: { NEXT_PUBLIC_DEMO_ACCOUNTS: demoAccountsFor(process.env.DEMO_ACCOUNTS) },
  // Lint runs once at the repository root (`pnpm lint`), against the shared config.
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages ship TypeScript source; Next compiles them alongside the app.
  transpilePackages: ['@sideout/ui', '@purse/sdk', '@purse/types', '@repo/ids', '@repo/db', '@repo/logger'],
  // postgres.js opens sockets; keep it a runtime dependency rather than a bundled one.
  serverExternalPackages: ['postgres'],
  // The service worker is versioned by its query string, never by the browser's cache: a new build must reach every open tab.
  headers: () => Promise.resolve([{ source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }] }]),
};

export default nextConfig;
