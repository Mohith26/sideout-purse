import { serve } from '@hono/node-server';

import { createLogger, errorFields, resolveBuildSha } from '@repo/logger';

import { createApp } from './app';
import { connect } from './db/client';
import { env } from './env';
import { assertRuntimeRole } from './ledger';
import { MIGRATIONS_FOLDER } from './paths';

const config = env();
const logger = createLogger({ service: 'purse-api', level: config.logLevel });
const database = connect(config.databaseUrl);
const sha = resolveBuildSha(config.buildSha);

// The API serves only as a role that can append to the journal and never rewrite it. A
// process handed the migrator's URL, or a role with too much, stops here.
try {
  const privileges = await assertRuntimeRole(database.sql);
  logger.info('runtime role verified', { role: privileges.role, appendOnly: true });
} catch (error) {
  logger.error('runtime role check failed', errorFields(error));
  await database.close();
  process.exit(1);
}

if (config.internalApiToken === undefined && config.nodeEnv === 'production') {
  logger.warn('INTERNAL_API_TOKEN is not set; GET /internal/reconcile is closed');
}

const app = createApp({
  sql: database.sql,
  db: database.db,
  logger,
  migrationsFolder: MIGRATIONS_FOLDER,
  sha,
  nodeEnv: config.nodeEnv,
  internalApiToken: config.internalApiToken,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('listening', { port: info.port, sha, nodeEnv: config.nodeEnv });
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  server.close((closeError) => {
    if (closeError) logger.error('server close failed', { reason: closeError.message });
    database
      .close()
      .catch((error: unknown) => {
        logger.error('database close failed', { reason: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        process.exit(closeError ? 1 : 0);
      });
  });
  // Do not hang forever on stuck connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
