import { parseArgs } from 'node:util';

import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { env } from '../src/env';
import { reconcileAndRecord } from '../src/ledger';

/**
 * Run every ledger invariant against the configured database, record the run in
 * `reconcile_runs` (what `/health` reports as the last reconcile result, spec section
 * 10) and exit non-zero if any fails (spec 4.2.4: anything but clean MUST fail the
 * build). Connects as the runtime role, which is all a read-only check plus one insert
 * needs, and proves that role can see the journal.
 *
 *   pnpm --filter @purse/api reconcile                      # source recorded as `cli`
 *   pnpm --filter @purse/api reconcile -- --source schedule # what the 15-minute cron runs
 *
 * A failed run is logged at error level, recorded, and the process exits 1, so a cron
 * host shows the run as failed and `/health` answers 503 until a clean run is recorded.
 */
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
  options: { source: { type: 'string', default: 'cli' } },
});
const source = args.source === 'schedule' ? 'schedule' : 'cli';

const logger = createLogger({ service: 'purse-reconcile', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 1, applicationName: 'purse-reconcile' });

try {
  const { report, run } = await reconcileAndRecord(database.db, source);
  for (const result of report.invariants) {
    const fields = { id: result.id, name: result.name, status: result.status, detail: result.detail };
    if (result.status === 'failed') logger.error('invariant failed', fields);
    else logger.info('invariant', fields);
  }
  if (report.ok) {
    logger.info('reconcile clean', { runId: run.id, source, durationMs: report.durationMs, nodeEnv: config.nodeEnv });
  } else {
    logger.error('reconcile failed', {
      runId: run.id,
      source,
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
