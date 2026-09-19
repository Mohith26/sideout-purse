import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { API_ORIGIN, DEPLOYED, PURSE_URL, SCREENSHOT_DIR, WEB_ORIGIN } from '../playwright.config';

/**
 * Bring the databases the servers under test read to the known-good state: the demo
 * reset (both halves, `DEMO_RESET=allow`), which is what the hosted nightly job runs.
 * The seed alone would not do, because the flows consume it (a team registers, a match is
 * settled, a tournament is closed) and a plain reseed leaves what they changed in place.
 * Purse is reset first, as the owner role (`PURSE_MIGRATOR_DATABASE_URL`), then Sideout,
 * whose reset mirrors the seeded events to the e2e Purse API. Against a deployed
 * environment (`BASE_URL`) nothing is reset from here: the deployed data is the seed, and
 * the reset is the host's job (docs/deploy.md); this only checks both services answer.
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
  const sideoutDir = path.resolve(import.meta.dirname, '..');
  const purseDir = path.resolve(sideoutDir, '../purse');
  const run = (cwd: string, args: string[], env: Record<string, string>): void => {
    const result = spawnSync('pnpm', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${args.join(' ')} in ${cwd} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  };
  // The e2e Sideout runs on a port of its own, so the Purse seed allowlists that origin for the embed.
  run(purseDir, ['run', 'demo:reset'], { DEMO_RESET: 'allow', LOG_LEVEL: 'warn', PURSE_TENANT_ORIGINS: WEB_ORIGIN });
  run(sideoutDir, ['run', 'demo:reset'], { DEMO_RESET: 'allow', PURSE_API_URL: API_ORIGIN, LOG_LEVEL: 'warn' });
}
