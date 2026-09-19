import path from 'node:path';

import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

import { DEVELOPMENT_PURSE_TENANT_ID } from './src/env';

/**
 * The ping-pong end-to-end smoke (docs/second-tenant.md): the production build (`pnpm
 * build` first) against a real Purse API on the seeded databases. Two servers are started
 * here, the API on :4030 and the ladder on :3110, apart from Sideout's :4020/:3010 and the
 * console's :4010/:4210 so the smokes can run side by side. `apps/pingpong/.env` is loaded
 * into this process when it exists (CI sets the variables instead; a variable already in
 * the environment wins); the Purse API reads `apps/purse/.env` the same way.
 * `e2e/global-setup.ts` seeds Purse (which allowlists this run's origin for the tenant)
 * and resets the ladder's database first.
 *
 * Against a deployed environment: `BASE_URL=https://...` and `E2E_PURSE_URL=https://...`
 * point the run at a live ladder and its Purse instead of starting servers; the ladder's
 * database is not reset from here, so the run needs no open season on the board.
 */
export const API_PORT = 4030;
export const WEB_PORT = 3110;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const LOCAL_SESSION_SECRET = 'pingpong-e2e-session-secret-for-the-playwright-run-only';
export const OFFICE_CODE = process.env['OFFICE_CODE'] ?? 'table-tennis';
export const SCREENSHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');

export const DEPLOYED: { baseUrl: string; purseUrl: string } | null = (() => {
  const baseUrl = process.env['BASE_URL'];
  if (baseUrl === undefined || baseUrl === '') return null;
  const purseUrl = process.env['E2E_PURSE_URL'];
  if (purseUrl === undefined) throw new Error('A deployed run (BASE_URL) needs E2E_PURSE_URL (its Purse API), and OFFICE_CODE (the deployment’s) to sign in.');
  return { baseUrl: baseUrl.replace(/\/+$/, ''), purseUrl: purseUrl.replace(/\/+$/, '') };
})();

export const BASE_URL = DEPLOYED?.baseUrl ?? WEB_ORIGIN;
export const PURSE_URL = DEPLOYED?.purseUrl ?? API_ORIGIN;

const purseDir = path.resolve(import.meta.dirname, '../purse');

try {
  process.loadEnvFile(path.join(import.meta.dirname, '.env'));
} catch {
  // No .env: CI exports the variables instead.
}

const secretKey = process.env['PINGPONG_PURSE_SECRET_KEY'];
/** `PINGPONG_PURSE_PUBLISHABLE_KEY` first, so a shell that also holds Sideout's `NEXT_PUBLIC_` key (CI) mounts this tenant's flows with this tenant's key. */
const publishableKey = process.env['PINGPONG_PURSE_PUBLISHABLE_KEY'] ?? process.env['NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY'];
if (DEPLOYED === null && (secretKey === undefined || publishableKey === undefined)) {
  throw new Error(
    'The ping-pong e2e needs PINGPONG_PURSE_SECRET_KEY and NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY (or PINGPONG_PURSE_PUBLISHABLE_KEY) in apps/pingpong/.env or the environment: `pnpm --filter @purse/api db:seed -- --print-keys` prints the tenant’s sandbox keys (label seed:pingpong:*) the one time they are created.',
  );
}

const webServer: PlaywrightTestConfig['webServer'] =
  DEPLOYED !== null
    ? undefined
    : [
        {
          command: `node --env-file-if-exists=${path.join(purseDir, '.env')} --import tsx src/index.ts`,
          cwd: purseDir,
          url: `${API_ORIGIN}/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { PORT: String(API_PORT), WEBHOOK_DISPATCHER: 'off', LOG_LEVEL: 'warn' },
        },
        {
          command: `pnpm exec next start --port ${WEB_PORT}`,
          cwd: import.meta.dirname,
          url: `${WEB_ORIGIN}/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: {
            LOG_LEVEL: 'warn',
            SESSION_SECRET: LOCAL_SESSION_SECRET,
            OFFICE_CODE,
            PURSE_API_URL: API_ORIGIN,
            NEXT_PUBLIC_PURSE_ORIGIN: API_ORIGIN,
            PINGPONG_PURSE_SECRET_KEY: secretKey ?? '',
            NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: publishableKey ?? '',
            NEXT_PUBLIC_PURSE_TENANT_ID: process.env['NEXT_PUBLIC_PURSE_TENANT_ID'] ?? DEVELOPMENT_PURSE_TENANT_ID,
          },
        },
      ];

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 120_000,
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1024, height: 900 }, deviceScaleFactor: 1 },
  ...(webServer === undefined ? {} : { webServer }),
});
