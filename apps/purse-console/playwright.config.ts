import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end smoke (spec section 8): the built console against a real Purse API on a
 * seeded database. Two servers are started here, the API on :4010 and the console on
 * :4210 (`next start`, so `pnpm build` first), both reading `apps/purse/.env` when it
 * exists (CI sets the variables instead). `e2e/global-setup.ts` seeds the database and
 * obtains the e2e admin's password the only way it exists: from the seed's own print.
 */
export const API_PORT = 4010;
export const CONSOLE_PORT = 4210;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const CONSOLE_ORIGIN = `http://127.0.0.1:${CONSOLE_PORT}`;

const purseDir = path.resolve(import.meta.dirname, '../purse');

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  use: { baseURL: CONSOLE_ORIGIN, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
      command: `pnpm exec next start --port ${CONSOLE_PORT}`,
      cwd: import.meta.dirname,
      url: `${CONSOLE_ORIGIN}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PURSE_API_ORIGIN: API_ORIGIN, LOG_LEVEL: 'warn' },
    },
  ],
});
