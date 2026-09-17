import { existsSync } from 'node:fs';
import path from 'node:path';

/** Load `apps/sideout/.env` if present, without overriding anything CI already set. */
const envFile = path.resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
