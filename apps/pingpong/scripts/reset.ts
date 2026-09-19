import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { clearAll, seedPlayers } from '../src/db/seed';
import { env } from '../src/env';

/**
 * Empty the ladder and reseed it: the known-good state for a demo or an end-to-end run.
 * Runs only with `DEMO_RESET=allow` in the environment and only against a database named
 * `pingpong`, `pingpong_demo*` or a test one. What it does not do is touch Purse: the
 * contests and users a season made there stay (Purse's own nightly reset removes them
 * along with everything else, docs/second-tenant.md).
 */
const log = createLogger({ service: 'pingpong-reset', level: 'info' });
if (process.env['DEMO_RESET'] !== 'allow') {
  log.error('refusing to reset: set DEMO_RESET=allow to run this');
  process.exit(2);
}
const config = env();
const database = connect(config.databaseUrl, { max: 1 });
try {
  const cleared = await clearAll(database.db);
  const seeded = await seedPlayers(database.db, new Date());
  log.info('reset complete', { database: cleared.database, deleted: cleared.deleted, players: seeded.players.map((p) => p.name) });
} catch (error) {
  log.error('reset failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
