import { runMigrations } from '@repo/db';

import { connect } from '../src/db/client';
import { env } from '../src/env';
import { createLogger, errorFields } from '../src/logger';
import { MIGRATIONS_FOLDER } from '../src/paths';

/**
 * Apply Purse's pending migrations, forward only. Exits non-zero on any failure so a
 * deploy step that runs this never continues to start a server on a half-migrated schema.
 */
const logger = createLogger({ service: 'purse-migrate', level: 'info' });
const config = env();
const database = connect(config.databaseUrl, { max: 1 });

try {
  const before = Date.now();
  const state = await runMigrations(database.sql, MIGRATIONS_FOLDER);
  logger.info('migrations applied', { ...state, durationMs: Date.now() - before, nodeEnv: config.nodeEnv });
  if (state.pending !== 0) {
    logger.error('migrations still pending after run', state);
    process.exitCode = 1;
  }
} catch (error) {
  logger.error('migration failed', errorFields(error));
  process.exitCode = 1;
} finally {
  await database.close();
}
