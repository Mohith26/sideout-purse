import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { assertRuntimeRole, issuePromoPoints, runtimeRolePrivileges } from '../../src/ledger';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { buildWorld, key, wipeLedger, type World } from './fixtures';

/**
 * Acceptance criterion 2 (spec 4.2.2 rule 5): UPDATE and DELETE on `journal_entries` and
 * `journal_lines` are revoked from the application role at the database level, proven by
 * a test that expects the failure. The same statements are then run as the owner, inside
 * a transaction that is rolled back, to prove it is the role and not the statement that
 * Postgres refuses.
 */
const JOURNAL = ['journal_entries', 'journal_lines'] as const;

describe('append-only enforcement at the role level', () => {
  let migrator: Database;
  let runtime: Database;
  let world: World;
  let entryId: string;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    world = await buildWorld(runtime.db, { wallets: 1, escrows: 0 });
    const posted = await issuePromoPoints(runtime.db, {
      tenantId: world.tenantId,
      asset: 'POINTS',
      promoLiabilityAccountId: world.promo.id,
      walletAccountId: world.wallets[0]?.id ?? '',
      amount: 10n,
      idempotencyKey: key(),
    });
    entryId = posted.entry.id;
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  /** The exact statements, parameterised by connection so the two roles run the same SQL. */
  function statements(db: Database) {
    return {
      journal_entries: {
        update: () => db.sql`update journal_entries set description = 'tampered' where id = ${entryId}`,
        delete: () => db.sql`delete from journal_entries where id = ${entryId}`,
        truncate: () => db.sql`truncate journal_entries cascade`,
      },
      journal_lines: {
        update: () => db.sql`update journal_lines set amount = amount + 1 where entry_id = ${entryId}`,
        delete: () => db.sql`delete from journal_lines where entry_id = ${entryId}`,
        truncate: () => db.sql`truncate journal_lines`,
      },
    };
  }

  it('the runtime role is refused UPDATE, DELETE and TRUNCATE on both journal tables', async () => {
    const asApp = statements(runtime);
    for (const table of JOURNAL) {
      for (const verb of ['update', 'delete', 'truncate'] as const) {
        const error = await rejection(asApp[table][verb]());
        expect(String(error), `${verb} ${table} as purse_app`).toMatch(new RegExp(`permission denied for table ${table}`));
      }
    }
    // Nothing changed.
    const [entry] = await runtime.sql<Array<{ description: string }>>`select description from journal_entries where id = ${entryId}`;
    expect(entry?.description).not.toBe('tampered');
    const [lines] = await runtime.sql<Array<{ n: number }>>`select count(*)::int as n from journal_lines where entry_id = ${entryId}`;
    expect(lines?.n).toBe(2);
  });

  it('the same statements succeed as the owner, so it is the role that is refused, not the SQL', async () => {
    await migrator.sql.begin(async (tx) => {
      const asOwner = statements({ ...migrator, sql: tx as unknown as Database['sql'] });
      // Updates first, then the lines before the entry they reference (a foreign key, not
      // a privilege, is all that stands between the owner and the delete).
      for (const table of JOURNAL) {
        await expect(asOwner[table].update(), `update ${table} as purse_migrator`).resolves.toBeDefined();
      }
      await expect(asOwner.journal_lines.delete(), 'delete journal_lines as purse_migrator').resolves.toBeDefined();
      await expect(asOwner.journal_entries.delete(), 'delete journal_entries as purse_migrator').resolves.toBeDefined();
      const [gone] = await tx<Array<{ n: number }>>`select count(*)::int as n from journal_entries where id = ${entryId}`;
      expect(gone?.n).toBe(0);
      // Never commit the tampering: history stays intact for the next test.
      throw new Error('rollback');
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback') throw error;
    });
    const [entry] = await runtime.sql<Array<{ description: string }>>`select description from journal_entries where id = ${entryId}`;
    expect(entry?.description).not.toBe('tampered');
  });

  it('the runtime role can still read and append, which is all it needs', async () => {
    const privileges = await runtimeRolePrivileges(runtime.sql);
    expect(privileges.role).toBe('purse_app');
    expect(privileges.ownedTables).toBe(0);
    for (const table of JOURNAL) {
      expect(privileges.tables[table]).toEqual({ present: true, select: true, insert: true, update: false, delete: false, truncate: false });
    }
    await expect(assertRuntimeRole(runtime.sql)).resolves.toMatchObject({ role: 'purse_app' });
  });

  it('the owner role fails the runtime check, so an API started on the migrator URL refuses to serve', async () => {
    const error = await rejection(assertRuntimeRole(migrator.sql));
    expect(String(error)).toMatch(/Refusing to serve as purse_migrator/);
    expect(String(error)).toMatch(/holds UPDATE, DELETE or TRUNCATE/);
    expect(String(error)).toMatch(/owns \d+ table/);
  });

  it('the runtime role owns nothing and cannot grant itself more', async () => {
    const [owned] = await runtime.sql<Array<{ n: number }>>`
      select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner
      where r.rolname = current_user and c.relnamespace = 'public'::regnamespace
    `;
    expect(owned?.n).toBe(0);

    // A non-owner's GRANT is a warning and a no-op in Postgres; ALTER OWNER is an error.
    await runtime.sql`grant update, delete on journal_entries, journal_lines to purse_app`.catch(() => undefined);
    const after = await runtimeRolePrivileges(runtime.sql);
    for (const table of JOURNAL) expect(after.tables[table]).toMatchObject({ update: false, delete: false, truncate: false });

    const takeover = await rejection(runtime.sql`alter table journal_entries owner to purse_app`);
    expect(String(takeover)).toMatch(/must be owner of table journal_entries/);
    const alter = await rejection(runtime.sql`alter table journal_lines drop constraint journal_lines_amount_positive`);
    expect(String(alter)).toMatch(/must be owner of table journal_lines/);
    const drop = await rejection(runtime.sql`drop table journal_lines`);
    expect(String(drop)).toMatch(/must be owner of table journal_lines/);
  });

  it('the audit log is append-only for the runtime role too', async () => {
    const error = await rejection(runtime.sql`delete from audit_log`);
    expect(String(error)).toMatch(/permission denied for table audit_log/);
    const update = await rejection(runtime.sql`update audit_log set action = 'x'`);
    expect(String(update)).toMatch(/permission denied for table audit_log/);
  });

  it('every table in the schema has an explicit grant for the runtime role (a new table with none fails here, not in production)', async () => {
    const tables = await migrator.sql<Array<{ table: string; select: boolean }>>`
      select tablename as "table", has_table_privilege('purse_app', format('public.%I', tablename), 'SELECT') as "select"
      from pg_tables where schemaname = 'public' order by tablename
    `;
    expect(tables.length).toBeGreaterThanOrEqual(5);
    for (const row of tables) expect(row.select, `purse_app has no SELECT on ${row.table}; grant it in a migration`).toBe(true);

    // And the runtime can read the migrations table for /health, but not write it.
    await expect(runtime.sql`select count(*) from drizzle.__drizzle_migrations`).resolves.toBeDefined();
    const write = await rejection(runtime.sql`delete from drizzle.__drizzle_migrations`);
    expect(String(write)).toMatch(/permission denied/);
    const tenantsDelete = await rejection(runtime.sql`delete from tenants where id = ${newId('tnt')}`);
    expect(String(tenantsDelete)).toMatch(/permission denied for table tenants/);
  });
});
