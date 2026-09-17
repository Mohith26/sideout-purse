import type { NextConfig } from 'next';

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
