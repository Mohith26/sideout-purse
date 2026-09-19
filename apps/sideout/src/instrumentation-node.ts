import { createLogger, errorFields } from '@repo/logger';

import { env } from './env';

/**
 * Parse the environment at boot so a misconfigured process refuses to start, logged once
 * and exited non-zero, instead of answering 500 to every request until someone reads the
 * log: a missing production variable, or a build made with the other `DEMO_ACCOUNTS`
 * setting (`src/env.ts`, `docs/demo-accounts.md`).
 */
export function checkEnvironmentOrExit(): void {
  try {
    env();
  } catch (error) {
    createLogger({ service: 'sideout-web', level: 'error' }).error('refusing to start', errorFields(error));
    process.exit(1);
  }
}
