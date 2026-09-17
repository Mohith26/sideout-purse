import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrationState, readMigrationJournal, runMigrations } from '@repo/db';

import { connect, type Database } from '../src/db/client';
import { auditLog, tenants } from '../src/db/schema';
import { env } from '../src/env';
import { MIGRATIONS_FOLDER } from '../src/paths';
import { SIDEOUT_TENANT_ID, SIDEOUT_TENANT_NAME } from '../src/tenants';
import { resetDatabase } from './global-setup';

describe('migration state reporting', () => {
  let database: Database;
  beforeAll(() => {
    database = connect(env().databaseUrl, { max: 1 });
  });
  afterAll(async () => {
    // Leave the database migrated for any test file that runs after this one.
    await runMigrations(database.sql, MIGRATIONS_FOLDER);
    await database.close();
  });

  it('reports everything pending on an empty database, then nothing after migrating', async () => {
    const journal = await readMigrationJournal(MIGRATIONS_FOLDER);
    expect(journal.entries.length).toBeGreaterThan(0);

    await resetDatabase(database.sql);
    expect(await migrationState(database.sql, MIGRATIONS_FOLDER)).toEqual({
      applied: 0,
      available: journal.entries.length,
      pending: journal.entries.length,
    });

    const after = await runMigrations(database.sql, MIGRATIONS_FOLDER);
    expect(after).toEqual({ applied: journal.entries.length, available: journal.entries.length, pending: 0 });

    // Idempotent: a second run applies nothing.
    expect(await runMigrations(database.sql, MIGRATIONS_FOLDER)).toEqual(after);
  });

  it('seeds the Sideout tenant with its stable id and audits it', async () => {
    const [tenant] = await database.db.select().from(tenants).where(eq(tenants.id, SIDEOUT_TENANT_ID));
    expect(tenant).toMatchObject({ id: SIDEOUT_TENANT_ID, name: SIDEOUT_TENANT_NAME, status: 'active' });

    const events = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, SIDEOUT_TENANT_ID));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorKind: 'system',
      action: 'tenant.created',
      subjectKind: 'tenant',
      tenantId: SIDEOUT_TENANT_ID,
      before: null,
    });
    expect(events[0]?.after).toMatchObject({ name: SIDEOUT_TENANT_NAME, status: 'active' });
  });

  it('rejects an id with the wrong prefix at the database level', async () => {
    const failure = await database.db
      .insert(tenants)
      .values({ id: 'usr_01a0b16a-b475-74d4-b1cb-2dbdc08845a9', name: 'Wrong' })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // drizzle wraps the driver error; the CHECK constraint name is on the cause.
    expect(String((failure as Error).cause)).toMatch(/tenants_id_prefix/);
  });
});
