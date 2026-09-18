import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Seed the database the API under test reads (idempotent; the same seed a deploy runs)
 * with a separate e2e admin, `e2e-admin@purse.local`, whose password is rotated and
 * printed by this run. The password exists nowhere else: the test reads it from the
 * seed's one log line and signs in with it. The real `admin@purse.local` is untouched.
 */
export const E2E_ADMIN_EMAIL = 'e2e-admin@purse.local';
export const CREDENTIALS_FILE = path.resolve(import.meta.dirname, '../test-results/e2e-credentials.json');

export default function globalSetup(): void {
  const purseDir = path.resolve(import.meta.dirname, '../../purse');
  const result = spawnSync('pnpm', ['run', 'db:seed', '--', '--print-operator-password', '--rotate-operator-password'], {
    cwd: purseDir,
    env: { ...process.env, PURSE_OPERATOR_ADMIN_EMAIL: E2E_ADMIN_EMAIL },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`db:seed failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  const lines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.startsWith('{'));
  let password: string | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { msg?: string; password?: string; email?: string };
      if (parsed.msg === 'console admin password' && parsed.email === E2E_ADMIN_EMAIL && typeof parsed.password === 'string') password = parsed.password;
    } catch {
      // Not a JSON log line; the seed also prints drizzle's output.
    }
  }
  if (password === undefined) throw new Error(`the seed did not print the e2e admin password:\n${result.stdout}\n${result.stderr}`);
  mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify({ email: E2E_ADMIN_EMAIL, password }), { mode: 0o600 });
}
