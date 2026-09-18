import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { assertRuntimeRole, issuePromoPoints, runtimeRolePrivileges } from '../../src/ledger';
import { APPEND_ONLY_TABLES } from '../../src/ledger/role-check';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { buildWorld, key, wipeLedger, type World } from './fixtures';

/**
 * Acceptance criterion 2 (spec 4.2.2 rule 5): UPDATE and DELETE on `journal_entries` and
 * `journal_lines` are revoked from the application role at the database level, proven by
 * a test that expects the failure. The audit log is held to the same rule. The same
 * statements are then run as the owner, inside a transaction that is rolled back, to
 * prove it is the role and not the statement that Postgres refuses.
 */
const APPEND_ONLY = ['journal_entries', 'journal_lines', 'audit_log'] as const;

describe('append-only enforcement at the role level', () => {
  let migrator: Database;
  let runtime: Database;
  let world: World;
  let entryId: string;
  let walletId: string;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    world = await buildWorld(runtime.db, { wallets: 1, escrows: 0 });
    walletId = world.wallets[0]?.id ?? '';
    const posted = await issuePromoPoints(runtime.db, {
      tenantId: world.tenantId,
      asset: 'POINTS',
      promoLiabilityAccountId: world.promo.id,
      walletAccountId: walletId,
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
      audit_log: {
        update: () => db.sql`update audit_log set action = 'tampered' where subject = ${walletId}`,
        delete: () => db.sql`delete from audit_log where subject = ${walletId}`,
        truncate: () => db.sql`truncate audit_log`,
      },
    };
  }

  it('the runtime role is refused UPDATE, DELETE and TRUNCATE on both journal tables and the audit log', async () => {
    const asApp = statements(runtime);
    for (const table of APPEND_ONLY) {
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
    const [audit] = await runtime.sql<Array<{ action: string }>>`select action from audit_log where subject = ${walletId}`;
    expect(audit?.action).toBe('account.opened');
  });

  it('the same statements succeed as the owner, so it is the role that is refused, not the SQL', async () => {
    await migrator.sql.begin(async (tx) => {
      const asOwner = statements({ ...migrator, sql: tx as unknown as Database['sql'] });
      // Updates first, then the lines before the entry they reference (a foreign key, not
      // a privilege, is all that stands between the owner and the delete).
      for (const table of APPEND_ONLY) {
        await expect(asOwner[table].update(), `update ${table} as purse_migrator`).resolves.toBeDefined();
      }
      await expect(asOwner.journal_lines.delete(), 'delete journal_lines as purse_migrator').resolves.toBeDefined();
      await expect(asOwner.journal_entries.delete(), 'delete journal_entries as purse_migrator').resolves.toBeDefined();
      await expect(asOwner.audit_log.delete(), 'delete audit_log as purse_migrator').resolves.toBeDefined();
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
    expect(APPEND_ONLY_TABLES).toEqual(['journal_entries', 'journal_lines', 'audit_log', 'contest_results', 'idempotency_keys', 'eligibility_decisions']);
    for (const table of APPEND_ONLY_TABLES) {
      expect(privileges.tables[table], table).toEqual({ present: true, select: true, insert: true, update: false, delete: false, truncate: false });
    }
    await expect(assertRuntimeRole(runtime.sql)).resolves.toMatchObject({ role: 'purse_app' });
  });

  it('the contest tables follow the same model: results and used keys are append-only, and only the columns that legitimately change are updatable', async () => {
    for (const [table, assignment] of [
      ['contest_results', 'computed_at = now()'],
      ['idempotency_keys', 'created_at = now()'],
      ['idempotency_reservations', "key = 'tampered'"],
    ] as const) {
      for (const statement of [
        () => runtime.sql.unsafe(`update ${table} set ${assignment}`),
        () => runtime.sql.unsafe(`delete from ${table}`),
        () => runtime.sql.unsafe(`truncate ${table}`),
      ]) {
        expect(String(await rejection(statement())), table).toMatch(new RegExp(`permission denied for table ${table}`));
      }
    }
    const columns = await runtime.sql<Array<{ table: string; column: string; update: boolean }>>`
      select c.table_name as "table", c.column_name as "column",
        has_column_privilege('purse_app', format('public.%I', c.table_name), c.column_name, 'UPDATE') as "update"
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name in ('contests', 'contest_participants', 'contest_scores', 'contest_results', 'idempotency_keys', 'idempotency_reservations')
      order by 1, 2
    `;
    const updatable = Object.fromEntries(
      ['contests', 'contest_participants', 'contest_scores', 'contest_results', 'idempotency_keys', 'idempotency_reservations'].map((table) => [
        table,
        columns.filter((row) => row.table === table && row.update).map((row) => row.column),
      ]),
    );
    expect(updatable).toEqual({
      contests: ['eligibility_ruleset_version', 'entry_amount', 'kind', 'locks_at', 'max_participants', 'opens_at', 'prize_structure', 'settled_at', 'settlement_policy', 'state', 'tie_break', 'title', 'updated_at'],
      contest_participants: ['entry_journal_entry_id', 'seed', 'state', 'team_ref', 'updated_at'],
      contest_scores: ['superseded_by'],
      contest_results: [],
      idempotency_keys: [],
      idempotency_reservations: ['expires_at', 'operation', 'request_hash', 'reserved_at'],
    });
    // Never the identity of a contest or of an entry.
    for (const column of ['id', 'tenant_id', 'external_id', 'asset', 'escrow_account_id', 'created_at']) {
      expect(updatable['contests'], column).not.toContain(column);
    }
    for (const column of ['id', 'contest_id', 'user_id', 'joined_at']) {
      expect(updatable['contest_participants'], column).not.toContain(column);
    }
    expect(updatable['contest_scores']).not.toContain('score');
  });

  it('the identity, eligibility and access tables follow the same model, column by column', async () => {
    const tables = ['users', 'user_verification', 'user_restrictions', 'user_locations', 'rulesets', 'eligibility_decisions', 'identity_fingerprints', 'operator_flags', 'api_keys', 'embed_tokens'];
    const columns = await runtime.sql<Array<{ table: string; column: string; update: boolean }>>`
      select c.table_name as "table", c.column_name as "column",
        has_column_privilege('purse_app', format('public.%I', c.table_name), c.column_name, 'UPDATE') as "update"
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = any(${runtime.sql.array(tables)}::text[])
      order by 1, 2
    `;
    const updatable = Object.fromEntries(tables.map((table) => [table, columns.filter((row) => row.table === table && row.update).map((row) => row.column)]));
    expect(updatable).toEqual({
      users: ['date_of_birth', 'display_name', 'phone_e164', 'updated_at'],
      user_verification: ['provider', 'provider_ref', 'reverify_after', 'state', 'updated_at', 'verified_at'],
      user_restrictions: ['lifted_at', 'lifted_by', 'updated_at'],
      user_locations: ['confidence', 'region_code', 'resolved_at', 'source', 'updated_at'],
      rulesets: ['active', 'updated_at'],
      eligibility_decisions: [],
      identity_fingerprints: ['computed_at', 'fingerprint'],
      operator_flags: ['reviewed_at', 'reviewed_by', 'status', 'updated_at'],
      api_keys: ['last_used_at', 'revoked_at', 'updated_at'],
      embed_tokens: ['consumed_at'],
    });
    // Append-only where a row is history: a decision, a used key. No DELETE or TRUNCATE anywhere.
    for (const table of tables) {
      for (const statement of [() => runtime.sql.unsafe(`delete from ${table}`), () => runtime.sql.unsafe(`truncate ${table}`)]) {
        expect(String(await rejection(statement())), table).toMatch(new RegExp(`permission denied for table ${table}`));
      }
    }
    expect(String(await rejection(runtime.sql`update eligibility_decisions set allowed = true`))).toMatch(/permission denied for table eligibility_decisions/);
    expect(String(await rejection(runtime.sql`update accounts set user_id = null where id = ${walletId}`))).toMatch(/permission denied for table accounts/);
  });

  it('the embed and webhook tables follow the same model: attempts are history, a delivery moves forward only, a secret envelope may rotate', async () => {
    const tables = ['tenant_origins', 'embed_signin_codes', 'webhook_endpoints', 'webhook_deliveries', 'webhook_delivery_attempts'];
    const columns = await runtime.sql<Array<{ table: string; column: string; update: boolean }>>`
      select c.table_name as "table", c.column_name as "column",
        has_column_privilege('purse_app', format('public.%I', c.table_name), c.column_name, 'UPDATE') as "update"
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = any(${runtime.sql.array(tables)}::text[])
      order by 1, 2
    `;
    const updatable = Object.fromEntries(tables.map((table) => [table, columns.filter((row) => row.table === table && row.update).map((row) => row.column)]));
    expect(updatable).toEqual({
      tenant_origins: ['revoked_at'],
      embed_signin_codes: ['attempts', 'consumed_at'],
      webhook_endpoints: ['description', 'signing_secret', 'status', 'subscribed_events', 'updated_at', 'url'],
      webhook_deliveries: ['attempt', 'delivered_at', 'locked_by', 'locked_until', 'next_attempt_at', 'response_status', 'status', 'updated_at'],
      webhook_delivery_attempts: [],
    });
    for (const table of tables) {
      for (const statement of [() => runtime.sql.unsafe(`delete from ${table}`), () => runtime.sql.unsafe(`truncate ${table}`)]) {
        expect(String(await rejection(statement())), table).toMatch(new RegExp(`permission denied for table ${table}`));
      }
    }
    expect(String(await rejection(runtime.sql`update webhook_delivery_attempts set response_status = 200`))).toMatch(/permission denied for table webhook_delivery_attempts/);
    expect(String(await rejection(runtime.sql`update webhook_deliveries set payload = '{}'::jsonb`))).toMatch(/permission denied for table webhook_deliveries/);
    expect(String(await rejection(runtime.sql`update webhook_endpoints set tenant_id = ${newId('tnt')}`))).toMatch(/permission denied for table webhook_endpoints/);
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
    await runtime.sql`grant update, delete on journal_entries, journal_lines, audit_log to purse_app`.catch(() => undefined);
    const after = await runtimeRolePrivileges(runtime.sql);
    for (const table of APPEND_ONLY) expect(after.tables[table]).toMatchObject({ update: false, delete: false, truncate: false });

    const takeover = await rejection(runtime.sql`alter table journal_entries owner to purse_app`);
    expect(String(takeover)).toMatch(/must be owner of table journal_entries/);
    const alter = await rejection(runtime.sql`alter table journal_lines drop constraint journal_lines_amount_positive`);
    expect(String(alter)).toMatch(/must be owner of table journal_lines/);
    const drop = await rejection(runtime.sql`drop table journal_lines`);
    expect(String(drop)).toMatch(/must be owner of table journal_lines/);
  });

  it('the runtime role may change an account’s status and nothing else about it', async () => {
    // What a derived balance depends on is fixed at open: rewriting it would edit history
    // without touching the journal, so purse_app holds UPDATE on status and updated_at only.
    await expect(runtime.sql`update accounts set status = 'frozen', updated_at = now() where id = ${walletId}`).resolves.toBeDefined();
    const [frozen] = await runtime.sql<Array<{ status: string }>>`select status from accounts where id = ${walletId}`;
    expect(frozen?.status).toBe('frozen');

    const otherTenant = newId('tnt');
    const rewrites = {
      'kind, normal_side, owner_ref and user_id': () => runtime.sql`update accounts set kind = 'external_settlement', normal_side = 'debit', owner_ref = null, user_id = null where id = ${walletId}`,
      user_id: () => runtime.sql`update accounts set user_id = null where id = ${walletId}`,
      kind: () => runtime.sql`update accounts set kind = 'external_settlement' where id = ${walletId}`,
      normal_side: () => runtime.sql`update accounts set normal_side = 'debit' where id = ${walletId}`,
      tenant_id: () => runtime.sql`update accounts set tenant_id = ${otherTenant} where id = ${walletId}`,
      owner_ref: () => runtime.sql`update accounts set owner_ref = ${newId('usr')} where id = ${walletId}`,
      asset: () => runtime.sql`update accounts set asset = 'CREDIT' where id = ${walletId}`,
      id: () => runtime.sql`update accounts set id = ${newId('acct')} where id = ${walletId}`,
      created_at: () => runtime.sql`update accounts set created_at = now() where id = ${walletId}`,
    };
    for (const [column, statement] of Object.entries(rewrites)) {
      const error = await rejection(statement());
      expect(String(error), `update accounts.${column} as purse_app`).toMatch(/permission denied for table accounts/);
    }
    const [account] = await runtime.sql<Array<{ kind: string; normal_side: string; tenant_id: string; asset: string }>>`
      select kind, normal_side, tenant_id, asset from accounts where id = ${walletId}
    `;
    expect(account).toEqual({ kind: 'user_wallet', normal_side: 'credit', tenant_id: world.tenantId, asset: 'POINTS' });

    // The same rewrite (a wallet turned into a debit-normal platform account, passing
    // every CHECK) succeeds as the owner, rolled back, so it is the role that is refused.
    await migrator.sql.begin(async (tx) => {
      await expect(tx`update accounts set kind = 'external_settlement', normal_side = 'debit', owner_ref = null, user_id = null where id = ${walletId}`).resolves.toBeDefined();
      throw new Error('rollback');
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback') throw error;
    });

    // Tenants follow the same shape: status may change, the identity may not.
    await expect(runtime.sql`update tenants set status = 'suspended', updated_at = now() where id = ${world.tenantId}`).resolves.toBeDefined();
    const rename = await rejection(runtime.sql`update tenants set name = 'renamed' where id = ${world.tenantId}`);
    expect(String(rename)).toMatch(/permission denied for table tenants/);
    const reid = await rejection(runtime.sql`update tenants set id = ${otherTenant} where id = ${world.tenantId}`);
    expect(String(reid)).toMatch(/permission denied for table tenants/);
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
