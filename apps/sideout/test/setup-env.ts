import { existsSync } from 'node:fs';
import path from 'node:path';

/** Load `apps/sideout/.env` if present, without overriding anything CI already set; else the `pnpm db:setup` default. */
const envFile = path.resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env['SIDEOUT_DATABASE_URL_TEST'] ??= 'postgres://sideout_app:sideout_app@localhost:5432/sideout_test';
