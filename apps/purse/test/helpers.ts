import { createLogger, type Logger } from '@repo/logger';

import { createApp } from '../src/app';
import { connect, type ConnectOptions, type Database } from '../src/db/client';
import { env, requireMigratorUrl } from '../src/env';
import { MIGRATIONS_FOLDER } from '../src/paths';

export type TestHarness = {
  app: ReturnType<typeof createApp>;
  database: Database;
  logger: Logger;
  lines: Array<Record<string, unknown>>;
  close(): Promise<void>;
};

/** The runtime role's connection, which is what the code under test uses. */
export function connectRuntime(options: ConnectOptions = {}): Database {
  return connect(env().databaseUrl, { max: 2, applicationName: 'purse-test', ...options });
}

/** The owner role's connection, for fixtures and teardown that the runtime role is not allowed to do. */
export function connectMigrator(options: ConnectOptions = {}): Database {
  return connect(requireMigratorUrl(env()), { max: 1, applicationName: 'purse-test-migrator', ...options });
}

export type HarnessOptions = { sha?: string; internalApiToken?: string };

/** An app wired to the test database (as the runtime role) with a logger that captures JSON lines in memory. */
export function harness(overrides: HarnessOptions = {}): TestHarness {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: 'purse-api-test',
    level: 'debug',
    write: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const database = connectRuntime();
  const app = createApp({
    sql: database.sql,
    db: database.db,
    logger,
    migrationsFolder: MIGRATIONS_FOLDER,
    sha: overrides.sha ?? 'test-sha',
    nodeEnv: 'test',
    internalApiToken: overrides.internalApiToken,
  });
  return { app, database, logger, lines, close: () => database.close() };
}

/** Await a promise that is expected to reject, returning the rejection. Fails when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}
