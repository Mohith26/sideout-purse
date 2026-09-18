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
const nextConfig: NextConfig = {
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
