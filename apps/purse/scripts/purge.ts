import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { env, requireMigratorUrl } from '../src/env';
import { purgeExpired } from '../src/maintenance/purge';

/**
 * Remove what has outlived its retention, as `purse_migrator` (the runtime role can delete
 * nothing): idempotency keys past their 30-day TTL (spec 4.1) and embed tokens that were
 * consumed or expired more than a day ago. Nothing in the journal, the audit log or the
 * decision record is ever touched. Exits non-zero on failure.
 *
 *   pnpm --filter @purse/api purge
 */
const logger = createLogger({ service: 'purse-purge', level: 'info' });
const config = env();
const database = connect(requireMigratorUrl(config), { max: 1, applicationName: 'purse-purge' });

try {
  const result = await purgeExpired(database.db);
  logger.info('purge complete', { ...result, nodeEnv: config.nodeEnv });
} catch (error) {
  logger.error('purge failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
