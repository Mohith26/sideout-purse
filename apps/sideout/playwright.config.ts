import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { DEVELOPMENT_PURSE_TENANT_ID } from './src/env';

/**
 * The Sideout end-to-end run (spec 5.3 and section 9, phase 8): the production build
 * (`pnpm build` first, so the service worker is registered and `/api/dev/login` does not
 * exist) against a real Purse API on the seeded databases. Two servers are started here,
 * the API on :4020 and Sideout on :3010, apart from the console's :4010/:4210 so the two
 * smokes can run side by side. `apps/sideout/.env` is loaded into this process when it
 * exists (CI sets the variables instead; a variable already in the environment wins), the
 * Purse API reads `apps/purse/.env` the same way.
 *
 * Sign-in: a production build has no dev login, so the specs mint session cookies with the
 * app's own `issueSession` (`e2e/session.ts`) under the secret this file hands the server.
 * The specs write screenshots of every screen at 390, 768 and 1280 into `docs/screenshots/`.
 */
export const API_PORT = 4020;
export const WEB_PORT = 3010;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/** `localhost`, not 127.0.0.1: the browser needs a secure context for the service worker, and Chromium grants it to localhost. */
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
/** Signs the e2e server's sessions; it exists for this run only, on a loopback port, over a seeded database. */
export const E2E_SESSION_SECRET = 'sideout-e2e-session-secret-for-the-playwright-run-only';
export const SCREENSHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');

const purseDir = path.resolve(import.meta.dirname, '../purse');

try {
  process.loadEnvFile(path.join(import.meta.dirname, '.env'));
} catch {
  // No .env: CI exports the variables instead.
}

const secretKey = process.env['SIDEOUT_PURSE_SECRET_KEY'];
const publishableKey = process.env['NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY'];
if (secretKey === undefined || publishableKey === undefined) {
  throw new Error(
    'The Sideout e2e needs SIDEOUT_PURSE_SECRET_KEY and NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY (in apps/sideout/.env or the environment): `pnpm --filter @purse/api db:seed -- --print-keys` prints the sandbox keys the one time they are created.',
  );
}

const viewport = (width: number, height: number) => ({ ...devices['Desktop Chrome'], viewport: { width, height }, deviceScaleFactor: 1 });

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 90_000,
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  use: { baseURL: WEB_ORIGIN, trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile', use: { ...viewport(390, 844), isMobile: true, hasTouch: true } },
    { name: 'tablet', use: viewport(768, 1024) },
    { name: 'desktop', use: viewport(1280, 800) },
  ],
  webServer: [
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
        SESSION_SECRET: E2E_SESSION_SECRET,
        PURSE_API_URL: API_ORIGIN,
        NEXT_PUBLIC_PURSE_ORIGIN: API_ORIGIN,
        SIDEOUT_PURSE_SECRET_KEY: secretKey,
        NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: publishableKey,
        NEXT_PUBLIC_PURSE_TENANT_ID: process.env['NEXT_PUBLIC_PURSE_TENANT_ID'] ?? DEVELOPMENT_PURSE_TENANT_ID,
        // Required in production; the dispatcher above is off, so nothing is verified against it here.
        PURSE_WEBHOOK_SECRET: process.env['PURSE_WEBHOOK_SECRET'] ?? 'whsec_sideout_e2e_placeholder',
      },
    },
  ],
});
