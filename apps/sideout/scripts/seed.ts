import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { buildSeed, defaultSeedAnchor, SEED_SLUGS, writeSeed } from '../src/db/seed';
import { purseReachable, seedPurse } from '../src/db/seed/purse';
import { env } from '../src/env';
import { databaseCallRecorder, PurseClient } from '../src/purse';

/**
 * Apply Sideout's seed data, idempotently: a charity, organizers and players, three
 * sponsors and one tournament in each of registration_open, live and settled, every draw
 * produced by the draw engine, every set legal and every played match carrying its
 * consensus. Runs after `db:migrate`; exits non-zero on any failure. `SEED_ANCHOR` (ISO
 * timestamp) pins the live event's start time.
 *
 * Then, when `PURSE_SECRET_KEY` is set and the Purse API at `PURSE_API_URL` answers, the
 * same rows are mirrored to Purse through the app's own services (`src/db/seed/purse.ts`):
 * a settled contest for the settled event, two pushed quarterfinals on the live one, and
 * `purse_calls` rows for all of it. Otherwise the contest columns stay null and the log
 * says so. `pnpm --filter @purse/api db:seed -- --print-keys` prints the sandbox key.
 */
const logger = createLogger({ service: 'sideout-seed', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 2 });

try {
  const pinned = process.env['SEED_ANCHOR'];
  const anchor = pinned === undefined ? defaultSeedAnchor() : new Date(pinned);
  if (Number.isNaN(anchor.getTime())) throw new Error(`SEED_ANCHOR is not a valid timestamp: ${pinned ?? ''}`);
  const dataset = buildSeed({ anchor });
  const summary = await writeSeed(database.db, dataset);
  logger.info('seed applied', { ...summary, anchor: anchor.toISOString(), slugs: SEED_SLUGS, nodeEnv: config.nodeEnv });

  if (config.purse.secretKey === undefined) {
    logger.warn('Purse walk skipped: PURSE_SECRET_KEY is not set; purse_contest_id stays null on every seeded tournament', { apiUrl: config.purse.apiUrl });
  } else if (!(await purseReachable(config.purse.apiUrl))) {
    logger.warn('Purse walk skipped: the Purse API is not reachable; purse_contest_id stays null on every seeded tournament', { apiUrl: config.purse.apiUrl });
  } else {
    const purse = new PurseClient({ baseUrl: config.purse.apiUrl, secretKey: config.purse.secretKey, recorder: databaseCallRecorder(database.db) });
    const walked = await seedPurse({ db: database.db, purse, log: logger, env: config.purse }, { now: new Date(), log: logger });
    logger.info('Purse walk applied', walked);
  }
} catch (error) {
  logger.error('seed failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
