import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import { API_ORIGIN, SCREENSHOT_DIR } from '../playwright.config';

/**
 * Seed the database the server under test reads (idempotent; the same seed a deploy runs):
 * the three events, their draws and consensus rows, mirrored to the e2e Purse API when it
 * answers. A rerun replays under the same keys, so a previous run's scoreline (the offline
 * spec submits one) is left where it was and the spec copes with either state.
 */
export default function globalSetup(): void {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const result = spawnSync('pnpm', ['run', 'db:seed'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PURSE_API_URL: API_ORIGIN, LOG_LEVEL: 'warn' },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`db:seed failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
}
