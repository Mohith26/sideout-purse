import { existsSync } from 'node:fs';
import path from 'node:path';

/** Load `apps/pingpong/.env` if present, without overriding anything CI already set; else the `pnpm db:setup` default. */
const envFile = path.resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env['PINGPONG_DATABASE_URL_TEST'] ??= 'postgres://pingpong_app:pingpong_app@localhost:5432/pingpong_test';
