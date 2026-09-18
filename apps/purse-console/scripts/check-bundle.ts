import { existsSync } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@repo/logger';

import { scanBundle } from '../src/lib/bundle-check';

/** Runs after `next build`: fails the build if any client bundle carries a secret (spec section 8, "grep the built client bundle for sk_"). */
const logger = createLogger({ service: 'purse-console-build', level: 'info' });
const staticDir = path.resolve(import.meta.dirname, '../.next/static');
if (!existsSync(staticDir)) {
  logger.error('no client bundle to check', { staticDir });
  process.exit(1);
}
const findings = scanBundle(staticDir);
if (findings.length > 0) {
  logger.error('client bundle carries a secret', { findings });
  process.exit(1);
}
logger.info('client bundle clean', { staticDir });
