import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * The operator console (spec 4.10) is a server-rendered Next.js app on its own origin
 * (`console.purse.<domain>`, port 4200 locally; docs/decisions.md, phase 5). Every page
 * reads through `src/server/api.ts`, which calls the Purse API's `/console` routes
 * server-to-server with the operator's session token from the console's HttpOnly cookie;
 * the browser talks only to this origin (`/api/purse/*` proxies mutations the same way).
 * No secret key exists in this app at all, which `scripts/check-bundle.ts` proves after
 * every build.
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
  transpilePackages: ['@sideout/ui', '@purse/types', '@repo/logger'],
  headers() {
    return Promise.resolve([
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
        ],
      },
    ]);
  },
};

export default nextConfig;
