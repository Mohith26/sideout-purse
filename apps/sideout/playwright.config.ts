import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

import { DEVELOPMENT_PURSE_TENANT_ID } from './src/env';

/**
 * The Sideout end-to-end run (spec section 8 and 9, phases 8 and 9): the production build
 * (`pnpm build` first, so the service worker is registered and `/api/dev/login` does not
 * exist) against a real Purse API on the seeded databases. Two servers are started here,
 * the API on :4020 and Sideout on :3010, apart from the console's :4010/:4210 so the two
 * smokes can run side by side. `apps/sideout/.env` is loaded into this process when it
 * exists (CI sets the variables instead; a variable already in the environment wins), the
 * Purse API reads `apps/purse/.env` the same way. `e2e/global-setup.ts` resets both
 * databases to the seed first (the demo reset, so a rerun starts from the known-good state
 * the flows consume).
 *
 * Sign-in: a production build has no dev login, so the specs mint session cookies with the
 * app's own `issueSession` (`e2e/session.ts`) under the secret this file hands the server.
 * The specs write screenshots of every screen at 390, 768 and 1280 into `docs/screenshots/`.
 *
 * Projects: `mobile`, `tablet` and `desktop` run the screen smoke, axe and the offline
 * queue at each width; `flows` runs the two section 8 flows (Player and Organizer,
 * `e2e/flows.spec.ts`) after them, because the flows consume the seed (they register a
 * team, settle a match and close a tournament).
 *
 * The demo-accounts switch (`docs/demo-accounts.md`) is a build-time setting: the local
 * server is started with the `DEMO_ACCOUNTS` the build under test was made with (read from
 * the build's own manifest, so the two never disagree), and `e2e/demo.spec.ts` skips itself
 * when that is off. CI builds with `DEMO_ACCOUNTS=true` so the picker is walked there;
 * locally, `DEMO_ACCOUNTS=true pnpm build` first.
 *
 * Against a deployed environment (acceptance criterion 30): `BASE_URL=https://...` points
 * the run at a live Sideout instead of starting servers; the flows then need
 * `SESSION_SECRET` (the deployment's, to mint sessions), `E2E_PURSE_URL` (its Purse API)
 * and `E2E_PURSE_INTERNAL_TOKEN` (that API's `INTERNAL_API_TOKEN`, for the invariant
 * check). Only the `flows` project is meant for that mode (`--project flows`); the
 * deployed data is the seed, so run the demo reset before a rerun (docs/deploy.md).
 */
/** `E2E_API_PORT` / `E2E_WEB_PORT` move the two local servers when another run (a sibling checkout) holds the defaults. */
function port(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : Number(value);
}
export const API_PORT = port('E2E_API_PORT', 4020);
export const WEB_PORT = port('E2E_WEB_PORT', 3010);
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/** `localhost`, not 127.0.0.1: the browser needs a secure context for the service worker, and Chromium grants it to localhost. */
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
/** Signs the local e2e server's sessions; it exists for this run only, on a loopback port, over a seeded database. */
export const LOCAL_SESSION_SECRET = 'sideout-e2e-session-secret-for-the-playwright-run-only';
/** The local e2e API's `INTERNAL_API_TOKEN`, for `GET /internal/reconcile` at the end of the Organizer flow. */
export const LOCAL_INTERNAL_TOKEN = 'sideout-e2e-internal-token-for-the-playwright-run-only';
export const SCREENSHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');

/** The deployed environment under test, when `BASE_URL` names one; `null` runs the local servers. */
export const DEPLOYED: { baseUrl: string; purseUrl: string; sessionSecret: string; internalToken: string | undefined } | null = (() => {
  const baseUrl = process.env['BASE_URL'];
  if (baseUrl === undefined || baseUrl === '') return null;
  const sessionSecret = process.env['SESSION_SECRET'];
  const purseUrl = process.env['E2E_PURSE_URL'];
  if (sessionSecret === undefined || purseUrl === undefined) {
    throw new Error('A deployed run (BASE_URL) needs SESSION_SECRET (the deployment’s, to mint sessions) and E2E_PURSE_URL (its Purse API); E2E_PURSE_INTERNAL_TOKEN is the API’s INTERNAL_API_TOKEN for the invariant check.');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), purseUrl: purseUrl.replace(/\/+$/, ''), sessionSecret, internalToken: process.env['E2E_PURSE_INTERNAL_TOKEN'] };
})();

/** Where the browser is pointed: the deployed origin, or the local server. */
export const BASE_URL = DEPLOYED?.baseUrl ?? WEB_ORIGIN;
/** The Purse API the run reads back from (the invariant check). */
export const PURSE_URL = DEPLOYED?.purseUrl ?? API_ORIGIN;
export const SESSION_SECRET = DEPLOYED?.sessionSecret ?? LOCAL_SESSION_SECRET;
export const INTERNAL_TOKEN = DEPLOYED === null ? LOCAL_INTERNAL_TOKEN : DEPLOYED.internalToken;

const purseDir = path.resolve(import.meta.dirname, '../purse');

/** What `next build` inlined for `NEXT_PUBLIC_DEMO_ACCOUNTS` (`next.config.ts`); `false` when there is no build yet. */
export function builtDemoAccounts(): 'true' | 'false' {
  try {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '.next/required-server-files.json'), 'utf8')) as { config?: { env?: Record<string, string> } };
    return manifest.config?.env?.['NEXT_PUBLIC_DEMO_ACCOUNTS'] === 'true' ? 'true' : 'false';
  } catch {
    return 'false';
  }
}

try {
  process.loadEnvFile(path.join(import.meta.dirname, '.env'));
} catch {
  // No .env: CI exports the variables instead.
}

const secretKey = process.env['SIDEOUT_PURSE_SECRET_KEY'];
const publishableKey = process.env['NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY'];
if (DEPLOYED === null && (secretKey === undefined || publishableKey === undefined)) {
  throw new Error(
    'The Sideout e2e needs SIDEOUT_PURSE_SECRET_KEY and NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY (in apps/sideout/.env or the environment): `pnpm --filter @purse/api db:seed -- --print-keys` prints the sandbox keys the one time they are created.',
  );
}

const viewport = (width: number, height: number) => ({ ...devices['Desktop Chrome'], viewport: { width, height }, deviceScaleFactor: 1 });
const SCREEN_PROJECTS = ['mobile', 'tablet', 'desktop'];

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
          env: { PORT: String(API_PORT), WEBHOOK_DISPATCHER: 'off', LOG_LEVEL: 'warn', INTERNAL_API_TOKEN: LOCAL_INTERNAL_TOKEN },
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
            PURSE_API_URL: API_ORIGIN,
            NEXT_PUBLIC_PURSE_ORIGIN: API_ORIGIN,
            SIDEOUT_PURSE_SECRET_KEY: secretKey ?? '',
            NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: publishableKey ?? '',
            NEXT_PUBLIC_PURSE_TENANT_ID: process.env['NEXT_PUBLIC_PURSE_TENANT_ID'] ?? DEVELOPMENT_PURSE_TENANT_ID,
            // Required in production; the dispatcher above is off, so nothing is verified against it here.
            PURSE_WEBHOOK_SECRET: process.env['PURSE_WEBHOOK_SECRET'] ?? 'whsec_sideout_e2e_placeholder',
            // As the build was made (a disagreement refuses to boot); `e2e/demo.spec.ts` skips when off.
            DEMO_ACCOUNTS: builtDemoAccounts(),
          },
        },
      ];

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 90_000,
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile', testIgnore: /flows\.spec\.ts/, use: { ...viewport(390, 844), isMobile: true, hasTouch: true } },
    { name: 'tablet', testIgnore: /flows\.spec\.ts/, use: viewport(768, 1024) },
    { name: 'desktop', testIgnore: /flows\.spec\.ts/, use: viewport(1280, 800) },
    // The flows run last locally (they consume the seed the screens are captured from); against a deployment they run on their own.
    { name: 'flows', testMatch: /flows\.spec\.ts/, use: viewport(390, 844), ...(DEPLOYED === null ? { dependencies: SCREEN_PROJECTS } : {}) },
  ],
  ...(webServer === undefined ? {} : { webServer }),
});
