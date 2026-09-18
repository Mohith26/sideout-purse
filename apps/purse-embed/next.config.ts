import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

/**
 * The embed app is a static export served by the Purse API under `/embed`, so the frame
 * the SDK mounts is on the Purse origin (spec 4.8 rule 1) and its calls to `/v1/embed/*`
 * are same-origin. `output: 'export'` applies to `next build`; `next dev` (port 4100)
 * keeps the dev server and instead proxies `/v1/*` to the API on port 4000, so the frame
 * still talks to one origin (its own) and the cookie lands there. Point the SDK at
 * `purseOrigin: 'http://localhost:4100'` for that; at `http://localhost:4000` to use a
 * build served by the API (docs/decisions.md, "Embed app hosting").
 */
export const EMBED_BASE_PATH = '/embed';
export const DEV_API_ORIGIN = process.env['PURSE_API_ORIGIN'] ?? 'http://localhost:4000';

export default function nextConfig(phase: string): NextConfig {
  const building = phase === PHASE_PRODUCTION_BUILD;
  return {
    reactStrictMode: true,
    poweredByHeader: false,
    basePath: EMBED_BASE_PATH,
    ...(building ? { output: 'export' } : {}),
    // Lint runs once at the repository root (`pnpm lint`), against the shared config.
    eslint: { ignoreDuringBuilds: true },
    transpilePackages: ['@sideout/ui', '@purse/types'],
    ...(building
      ? {}
      : {
          rewrites: () => Promise.resolve([{ source: '/v1/:path*', destination: `${DEV_API_ORIGIN}/v1/:path*`, basePath: false as const }]),
        }),
  };
}
