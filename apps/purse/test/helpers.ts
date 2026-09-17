import { createApp } from '../src/app';
import { connect, type Database } from '../src/db/client';
import { env } from '../src/env';
import { createLogger, type Logger } from '../src/logger';
import { MIGRATIONS_FOLDER } from '../src/paths';

export type TestHarness = {
  app: ReturnType<typeof createApp>;
  database: Database;
  logger: Logger;
  lines: Array<Record<string, unknown>>;
  close(): Promise<void>;
};

/** An app wired to the test database with a logger that captures JSON lines in memory. */
export function harness(overrides: { sha?: string } = {}): TestHarness {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: 'purse-api-test',
    level: 'debug',
    write: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const database = connect(env().databaseUrl, { max: 2 });
  const app = createApp({
    sql: database.sql,
    logger,
    migrationsFolder: MIGRATIONS_FOLDER,
    sha: overrides.sha ?? 'test-sha',
  });
  return { app, database, logger, lines, close: () => database.close() };
}
