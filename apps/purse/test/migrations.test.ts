import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationState, readMigrationJournal, runMigrations } from '@repo/db';

import type { Database } from '../src/db/client';
import { tenants } from '../src/db/schema';
import { MIGRATIONS_FOLDER } from '../src/paths';
import { resetDatabase } from './global-setup';
import { connectMigrator, connectRuntime } from './helpers';

describe('migration state reporting', () => {
  let migrator: Database;
  let runtime: Database;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  afterAll(async () => {
    // Leave the database migrated for any test file that runs after this one.
    await runMigrations(migrator.sql, MIGRATIONS_FOLDER);
    await migrator.close();
    await runtime.close();
  });

  it('reports everything pending on an empty database, then nothing after migrating', async () => {
    const journal = await readMigrationJournal(MIGRATIONS_FOLDER);
    expect(journal.entries.length).toBeGreaterThan(0);

    await resetDatabase(migrator.sql);
    expect(await migrationState(migrator.sql, MIGRATIONS_FOLDER)).toEqual({
      applied: 0,
      available: journal.entries.length,
      pending: journal.entries.length,
    });

    const after = await runMigrations(migrator.sql, MIGRATIONS_FOLDER);
    expect(after).toEqual({ applied: journal.entries.length, available: journal.entries.length, pending: 0 });

    // Idempotent: a second run applies nothing.
    expect(await runMigrations(migrator.sql, MIGRATIONS_FOLDER)).toEqual(after);

    // The runtime role sees the same state (it reads, only reads, the migrations table).
    expect(await migrationState(runtime.sql, MIGRATIONS_FOLDER)).toEqual(after);
  });

  it('cannot be run by the runtime role', async () => {
    await resetDatabase(migrator.sql);
    try {
      // purse_app owns nothing, so it cannot even create the migrations schema.
      const failure = await runMigrations(runtime.sql, MIGRATIONS_FOLDER).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).cause)).toMatch(/permission denied/);
    } finally {
      await runMigrations(migrator.sql, MIGRATIONS_FOLDER);
    }
  });

  it('rejects an id with the wrong prefix at the database level', async () => {
    const failure = await runtime.db
      .insert(tenants)
      .values({ id: 'usr_01a0b16a-b475-74d4-b1cb-2dbdc08845a9', name: 'Wrong' })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // drizzle wraps the driver error; the CHECK constraint name is on the cause.
    expect(String((failure as Error).cause)).toMatch(/tenants_id_prefix/);
  });
});
