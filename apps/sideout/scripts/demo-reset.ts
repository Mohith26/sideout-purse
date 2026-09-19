import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { clearAllData } from '../src/db/demo-reset';
import { buildSeed, defaultSeedAnchor, SEED_SLUGS, writeSeed } from '../src/db/seed';
import { purseReachable, seedPurse } from '../src/db/seed/purse';
import { env } from '../src/env';
import { databaseCallRecorder, PurseClient } from '../src/purse';

/**
 * Reset the public demo's Sideout database to the seed (spec section 10, the nightly demo
 * reset): empty every table, write the seed anchored on today, then mirror the seeded
 * events to Purse through the app's own services, exactly as `db:seed` does after
 * `apps/purse/scripts/demo-reset.ts` has reset Purse. Unlike `db:seed`, the Purse walk is
 * required here: a demo whose events are not on Purse is not the known-good state, so a
 * missing key or an unreachable API fails the run. Exits non-zero on any failure.
 *
 * Refuses to run unless `DEMO_RESET=allow` is set, like the Purse half.
 *
 *   DEMO_RESET=allow pnpm --filter @sideout/web demo:reset
 */
const logger = createLogger({ service: 'sideout-demo-reset', level: 'info' });
if (process.env['DEMO_RESET'] !== 'allow') {
  logger.error('refusing to reset: DEMO_RESET=allow is not set');
  process.exit(2);
}
const config = env();
const database = connect(config.databaseUrl, { max: 2 });

try {
  const cleared = await clearAllData(database.db);
  logger.info('demo data cleared', cleared);

  const pinned = process.env['SEED_ANCHOR'];
  const anchor = pinned === undefined ? defaultSeedAnchor() : new Date(pinned);
  if (Number.isNaN(anchor.getTime())) throw new Error(`SEED_ANCHOR is not a valid timestamp: ${pinned ?? ''}`);
  const summary = await writeSeed(database.db, buildSeed({ anchor }));
  logger.info('seed applied', { ...summary, anchor: anchor.toISOString(), slugs: SEED_SLUGS, nodeEnv: config.nodeEnv });

  if (config.purse.secretKey === undefined) throw new Error('SIDEOUT_PURSE_SECRET_KEY is not set; the demo reset must mirror the seed to Purse');
  if (!(await purseReachable(config.purse.apiUrl))) throw new Error(`the Purse API at ${config.purse.apiUrl} did not answer /health; the demo reset must mirror the seed to Purse`);
  const purse = new PurseClient({ baseUrl: config.purse.apiUrl, secretKey: config.purse.secretKey, recorder: databaseCallRecorder(database.db) });
  const walked = await seedPurse({ db: database.db, purse, log: logger, env: config.purse }, { now: new Date(), anchor, log: logger });
  logger.info('demo reset complete', walked);
} catch (error) {
  logger.error('demo reset failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
