import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { DEPLOYED, PURSE_URL, SCREENSHOT_DIR, WEB_ORIGIN } from '../playwright.config';

/**
 * Bring the databases the servers under test read to the known-good state: Purse is
 * migrated and seeded (idempotent; the seed allowlists this run's origin for the ping-pong
 * tenant) and the ladder's database is emptied and reseeded (`DEMO_RESET=allow`), so the
 * smoke starts with no season on the board. Against a deployed environment (`BASE_URL`)
 * nothing is reset from here; this only checks both services answer.
 */
export default async function globalSetup(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  if (DEPLOYED !== null) {
    for (const url of [`${DEPLOYED.baseUrl}/health`, `${PURSE_URL}/health`]) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${url} answered ${response.status}; the deployed environment is not healthy`);
    }
    return;
  }
  const appDir = path.resolve(import.meta.dirname, '..');
  const purseDir = path.resolve(appDir, '../purse');
  const run = (cwd: string, args: string[], env: Record<string, string>): void => {
    const result = spawnSync('pnpm', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${args.join(' ')} in ${cwd} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  };
  run(purseDir, ['run', 'db:migrate'], { LOG_LEVEL: 'warn' });
  run(purseDir, ['run', 'db:seed'], { LOG_LEVEL: 'warn', PURSE_PINGPONG_ORIGINS: WEB_ORIGIN });
  run(appDir, ['run', 'db:migrate'], { LOG_LEVEL: 'warn' });
  run(appDir, ['run', 'demo:reset'], { DEMO_RESET: 'allow', LOG_LEVEL: 'warn' });
}
