import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the test database URLs for this process: `apps/purse/.env` if it exists, never
 * overriding anything CI has already set, then the URLs `pnpm db:setup` provisions by
 * default, so a fresh clone runs the tests after only db:setup. Runs in every worker
 * (vitest `setupFiles`) and in `global-setup.ts`. `vitest.config.ts` forces NODE_ENV=test,
 * so `env()` resolves the `_TEST` URLs and the development database is never touched by a test.
 * The runtime `loadEnv` stays strict; these fallbacks exist only here.
 */
const envFile = path.resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env['PURSE_DATABASE_URL_TEST'] ??= 'postgres://purse_app:purse_app@localhost:5432/purse_test';
process.env['PURSE_MIGRATOR_DATABASE_URL_TEST'] ??= 'postgres://purse_migrator:purse_migrator@localhost:5432/purse_test';
