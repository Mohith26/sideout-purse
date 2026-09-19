import type { NextConfig } from 'next';

/**
 * The second tenant's Next config (docs/second-tenant.md). Nothing here names Purse's
 * source: the app reaches the platform through `@purse/sdk` in the browser and its own
 * `src/purse` client on the server, both over HTTP.
 */
const nextConfig: NextConfig = {
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
