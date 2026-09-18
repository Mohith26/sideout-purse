import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { buildSeed, defaultSeedAnchor, SEED_SLUGS, writeSeed } from '../src/db/seed';
import { env } from '../src/env';

/**
 * Apply Sideout's seed data, idempotently: a charity, organizers and players, three
 * sponsors and one tournament in each of registration_open, live and settled, every draw
 * produced by the draw engine and every set legal. Runs after `db:migrate`; exits non-zero
 * on any failure. `SEED_ANCHOR` (ISO timestamp) pins the live event's start time.
 */
const logger = createLogger({ service: 'sideout-seed', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 1 });

try {
  const pinned = process.env['SEED_ANCHOR'];
  const anchor = pinned === undefined ? defaultSeedAnchor() : new Date(pinned);
  if (Number.isNaN(anchor.getTime())) throw new Error(`SEED_ANCHOR is not a valid timestamp: ${pinned ?? ''}`);
  const dataset = buildSeed({ anchor });
  const summary = await writeSeed(database.db, dataset);
  logger.info('seed applied', { ...summary, anchor: anchor.toISOString(), slugs: SEED_SLUGS, nodeEnv: config.nodeEnv });
} catch (error) {
  logger.error('seed failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
