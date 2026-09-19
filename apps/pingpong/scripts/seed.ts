import { createLogger, errorFields } from '@repo/logger';

import { connect } from '../src/db/client';
import { seedPlayers } from '../src/db/seed';
import { env } from '../src/env';
import { logger } from '../src/lib/logger';
import { databaseCallRecorder, isPurseFailure, PurseClient } from '../src/purse';
import { linkPurseUser } from '../src/server/purse/users';

/**
 * Apply the ladder's seed, idempotently: the four regulars, and, when a Purse secret key
 * is configured and the API answers, their Purse links (an upsert each; the welcome
 * points are keyed once). Without a key the walk is skipped and said so. Exits non-zero
 * on a database failure; a Purse failure is logged and leaves the players unlinked, to
 * be linked from the app.
 */
const log = createLogger({ service: 'pingpong-seed', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 1 });

try {
  const now = new Date();
  const seeded = await seedPlayers(database.db, now);
  log.info('players present', { created: seeded.created, players: seeded.players.map((p) => p.name), nodeEnv: config.nodeEnv });
  if (config.purse.secretKey === undefined) {
    log.info('purse walk skipped: PINGPONG_PURSE_SECRET_KEY is not set');
  } else {
    const purse = new PurseClient({ baseUrl: config.purse.apiUrl, secretKey: config.purse.secretKey, recorder: databaseCallRecorder(database.db) });
    const deps = { db: database.db, purse, log: logger(config.logLevel), env: config.purse };
    for (const player of seeded.players) {
      try {
        const profile = await linkPurseUser(deps, { player, requestId: crypto.randomUUID(), now });
        log.info('player linked to Purse', { player: player.name, points: profile.wallet.find((b) => b.asset === 'POINTS')?.balance ?? null });
      } catch (error) {
        if (!isPurseFailure(error)) throw error;
        log.warn('player not linked: Purse did not accept the link', { player: player.name, reason: error.message });
      }
    }
  }
} catch (error) {
  log.error('seed failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
