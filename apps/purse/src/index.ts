import { serve } from '@hono/node-server';

import { createApp } from './app';
import { resolveBuildSha } from './build-info';
import { connect } from './db/client';
import { env } from './env';
import { createLogger } from './logger';
import { MIGRATIONS_FOLDER } from './paths';

const config = env();
const logger = createLogger({ service: 'purse-api', level: config.logLevel });
const database = connect(config.databaseUrl);
const sha = resolveBuildSha(config.buildSha);

const app = createApp({ sql: database.sql, logger, migrationsFolder: MIGRATIONS_FOLDER, sha });

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
