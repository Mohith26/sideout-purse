import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { env } from '../src/env';
import { reconcile } from '../src/ledger';

/**
 * Run every ledger invariant against the configured database and exit non-zero if any
 * fails (spec 4.2.4: anything but clean MUST fail the build). Connects as the runtime
 * role, which is all a read-only check needs and proves that role can see the journal.
 *
 *   pnpm --filter @purse/api reconcile
 */
const logger = createLogger({ service: 'purse-reconcile', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 1, applicationName: 'purse-reconcile' });

try {
  const report = await reconcile(database.db);
  for (const result of report.invariants) {
    const fields = { id: result.id, name: result.name, status: result.status, detail: result.detail };
    if (result.status === 'failed') logger.error('invariant failed', fields);
    else logger.info('invariant', fields);
  }
  if (report.ok) {
    logger.info('reconcile clean', { durationMs: report.durationMs, nodeEnv: config.nodeEnv });
  } else {
    logger.error('reconcile failed', {
      failed: report.invariants.filter((result) => !result.ok).map((result) => result.id),
      durationMs: report.durationMs,
      nodeEnv: config.nodeEnv,
    });
    process.exitCode = 1;
  }
} catch (error) {
  logger.error('reconcile could not run', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
