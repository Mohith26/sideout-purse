import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load `apps/purse/.env` into the worker if it exists, without overriding anything CI has
 * already set. `vitest.config.ts` forces NODE_ENV=test, so `env()` resolves the `_TEST`
 * database URL and the development database is never touched by a test.
 */
const envFile = path.resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
