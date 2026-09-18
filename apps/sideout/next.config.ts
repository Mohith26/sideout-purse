import type { NextConfig } from 'next';

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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  pageExtensions: pageExtensionsFor(process.env.NODE_ENV),
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
