import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import { authenticateApiKey, resetAuthCaches } from '../src/auth';
import { listParticipants, listResults } from '../src/contests';
import type { Database } from '../src/db/client';
import { accounts, apiKeys, auditLog, contests, operatorFlags, operatorSessions, operators, rulesets, tenants, userLocations, userRestrictions, users } from '../src/db/schema';
import {
  PLATFORM_ACCOUNT_KINDS,
  SEED_API_KEYS,
  SEED_CONTESTS,
  SEED_USER_IDS,
  SEED_USERS,
  SIDEOUT_TENANT_ID,
  SIDEOUT_TENANT_NAME,
  DEFAULT_OPERATOR_ADMIN_EMAIL,
  seedApiKeys,
  seedContests,
  seedOperatorAdmin,
  seedPlatformAccounts,
  seedRuleset,
  seedSideoutTenant,
  seedUsers,
} from '../src/db/seed';
import { SPEC_EXAMPLE_RULESET } from '../src/eligibility';
import { balanceOf, findAccount, reconcile } from '../src/ledger';
import { authenticateSession, signIn } from '../src/operators';
import { getVerification } from '../src/users';
import { connectMigrator, connectRuntime } from './helpers';
import { wipeLedger } from './ledger/fixtures';

describe('db:seed', () => {
  // The seed runs as the owner role, exactly as `pnpm db:seed` does.
  let database: Database;
  let runtime: Database;
  beforeAll(() => {
    database = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(database);
  });
  afterAll(async () => {
    await wipeLedger(database);
    await database.close();
    await runtime.close();
  });

  it('creates the Sideout tenant with its stable id on an empty database', async () => {
    const result = await seedSideoutTenant(database.db);
    expect(result.created).toBe(true);
    expect(result.tenant).toMatchObject({ id: SIDEOUT_TENANT_ID, name: SIDEOUT_TENANT_NAME, status: 'active' });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('is idempotent: a second run changes nothing and reports the row already present', async () => {
    const first = await seedSideoutTenant(database.db);
    const second = await seedSideoutTenant(database.db);
    expect(second).toEqual({ tenant: first.tenant, created: false });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('keys on the name, so an existing Sideout tenant is kept as is rather than duplicated', async () => {
    const existingId = newId('tnt');
    await database.db.insert(tenants).values({ id: existingId, name: SIDEOUT_TENANT_NAME, status: 'suspended' });

    const result = await seedSideoutTenant(database.db);
    expect(result.created).toBe(false);
    expect(result.tenant).toMatchObject({ id: existingId, name: SIDEOUT_TENANT_NAME, status: 'suspended' });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('opens the platform accounts per asset once, with no user wallets', async () => {
    const { tenant } = await seedSideoutTenant(database.db);
    const first = await seedPlatformAccounts(database.db, tenant.id);
    expect(first.created).toBe(PLATFORM_ACCOUNT_KINDS.length * 2);
    expect(first.accounts).toHaveLength(PLATFORM_ACCOUNT_KINDS.length * 2);

    const keys = first.accounts.map((account) => `${account.kind}/${account.asset}`).sort();
    expect(keys).toEqual(
      ['promo_liability', 'platform_fee', 'external_settlement'].flatMap((kind) => [`${kind}/CREDIT`, `${kind}/POINTS`]).sort(),
    );
    for (const account of first.accounts) {
      expect(account.tenantId).toBe(tenant.id);
      expect(account.ownerRef).toBeNull();
      expect(account.status).toBe('open');
      expect(account.kind).not.toBe('user_wallet');
    }
    // Normal sides follow the spec table.
    expect(first.accounts.find((a) => a.kind === 'promo_liability')?.normalSide).toBe('credit');
    expect(first.accounts.find((a) => a.kind === 'external_settlement')?.normalSide).toBe('debit');

    // Idempotent: the same six rows, nothing new, and one audit row per account opened.
    const second = await seedPlatformAccounts(database.db, tenant.id);
    expect(second.created).toBe(0);
    expect(second.accounts.map((a) => a.id).sort()).toEqual(first.accounts.map((a) => a.id).sort());
    expect(await database.db.select().from(accounts)).toHaveLength(PLATFORM_ACCOUNT_KINDS.length * 2);
    const audit = await database.db.select().from(auditLog);
    expect(audit).toHaveLength(PLATFORM_ACCOUNT_KINDS.length * 2);
    expect(audit.every((row) => row.action === 'account.opened' && row.actorKind === 'system')).toBe(true);
  });

  it('publishes the spec example ruleset as the active version, once', async () => {
    const first = await seedRuleset(database.db);
    expect(first.created).toBe(true);
    expect(first.ruleset).toMatchObject({ version: SPEC_EXAMPLE_RULESET.version, active: true, body: SPEC_EXAMPLE_RULESET });
    const second = await seedRuleset(database.db);
    expect(second.created).toBe(false);
    expect(await database.db.select().from(rulesets)).toHaveLength(1);
  });

  it('seeds six users covering every verification state, their locations, one self-exclusion and the duplicate-identity flag, idempotently', async () => {
    const { tenant } = await seedSideoutTenant(database.db);
    await seedRuleset(database.db);
    const first = await seedUsers(database.db, tenant.id as Id<'tnt'>);
    expect(first.users.map((user) => [user.externalId, user.verification, user.created])).toEqual(SEED_USERS.map((user) => [user.externalId, user.verification, true]));
    expect(first.users.map((user) => user.id)).toEqual([...SEED_USER_IDS]);
    expect(new Set(first.users.map((user) => user.verification))).toEqual(new Set(['verified', 'pending', 'rejected', 'unstarted']));
    // Users 5 and 6 share a name and a date of birth: one duplicate-identity flag for the pair.
    expect(first.duplicateFlags).toBe(1);
    const flags = await runtime.db.select().from(operatorFlags);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'duplicate_identity', status: 'open', dedupeKey: `pair:${SEED_USER_IDS[4]}:${SEED_USER_IDS[5]}` });
    // Locations for the five who declared one; a self-exclusion on the sixth.
    expect(await runtime.db.select().from(userLocations)).toHaveLength(SEED_USERS.filter((user) => user.region !== null).length);
    const restrictions = await runtime.db.select().from(userRestrictions);
    expect(restrictions).toHaveLength(1);
    expect(restrictions[0]).toMatchObject({ userId: SEED_USER_IDS[5], kind: 'self_exclusion', createdBy: `user:${SEED_USER_IDS[5]}`, liftedAt: null });
    // The verified users carry a provider reference and a re-verify date, never anything else.
    const verified = await getVerification(runtime.db, SEED_USER_IDS[0] ?? '');
    expect(verified).toMatchObject({ state: 'verified', provider: 'dev' });
    expect(verified.providerRef).toMatch(/^dev-[0-9a-f]{24}$/);
    expect(verified.reverifyAfter?.getTime()).toBeGreaterThan(Date.now());

    // A rerun creates and changes nothing.
    const second = await seedUsers(database.db, tenant.id as Id<'tnt'>);
    expect(second.users.map((user) => [user.externalId, user.verification, user.created])).toEqual(SEED_USERS.map((user) => [user.externalId, user.verification, false]));
    expect(second.duplicateFlags).toBe(0);
    expect(await runtime.db.select().from(users)).toHaveLength(6);
    expect(await runtime.db.select().from(operatorFlags)).toHaveLength(1);
    expect(await runtime.db.select().from(userRestrictions)).toHaveLength(1);
  });

  it('completes the placeholder users a phase 2 database was left with, keeping their wallets', async () => {
    const { tenant } = await seedSideoutTenant(database.db);
    await seedRuleset(database.db);
    // What the 0007 migration backfills for a wallet that predates the users table.
    const legacy = SEED_USER_IDS[0] ?? '';
    await database.db.insert(users).values({ id: legacy, tenantId: tenant.id, externalId: `legacy:${legacy}` });
    await seedUsers(database.db, tenant.id as Id<'tnt'>);
    const [row] = await runtime.db.select().from(users).where(eq(users.id, legacy));
    expect(row).toMatchObject({ externalId: 'seed:user-1', displayName: 'Ana Reyes' });
    expect(await runtime.db.select().from(users)).toHaveLength(6);
  });

  it('mints one sandbox secret key with the operator scope and one publishable key, authenticates the secret, and rotates on request', async () => {
    const { tenant } = await seedSideoutTenant(database.db);
    resetAuthCaches();
    const first = await seedApiKeys(database.db, tenant.id as Id<'tnt'>);
    expect(first.keys.map((each) => [each.key.label, each.key.kind, each.key.environment, each.key.scopes, each.created])).toEqual(
      SEED_API_KEYS.map((each) => [each.label, each.kind, each.environment, [...each.scopes], true]),
    );
    const secret = first.keys[0];
    expect(secret?.plaintext).toMatch(/^sk_sandbox_[A-Za-z0-9]{32}$/);
    expect(first.keys[1]?.plaintext).toMatch(/^pk_sandbox_[A-Za-z0-9]{32}$/);
    const auth = await authenticateApiKey(runtime.db, secret?.plaintext ?? '');
    expect(auth.tenant.id).toBe(tenant.id);
    expect(auth.actor).toEqual({ kind: 'operator', ref: secret?.key.id });

    // A rerun finds the keys and has no plaintext to give.
    const second = await seedApiKeys(database.db, tenant.id as Id<'tnt'>);
    expect(second.keys.map((each) => [each.key.id, each.plaintext, each.created])).toEqual(first.keys.map((each) => [each.key.id, null, false]));
    expect(await runtime.db.select().from(apiKeys)).toHaveLength(2);

    // Rotation revokes the seed keys and mints new ones; the old secret stops working.
    const rotated = await seedApiKeys(database.db, tenant.id as Id<'tnt'>, { rotate: true });
    expect(rotated.keys.every((each) => each.created && each.plaintext !== null)).toBe(true);
    expect(await runtime.db.select().from(apiKeys)).toHaveLength(4);
    // The old secret stops working at once (the verified cache is cleared with the revocation), and the revocation is audited like any other.
    await expect(authenticateApiKey(runtime.db, secret?.plaintext ?? '')).rejects.toMatchObject({ code: 'api_key_revoked' });
    const revoked = await runtime.db.select().from(auditLog).where(and(eq(auditLog.action, 'api_key.revoked'), eq(auditLog.subject, secret?.key.id ?? '')));
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ actorKind: 'operator', actorRef: 'seed' });
    await expect(authenticateApiKey(runtime.db, rotated.keys[0]?.plaintext ?? '')).resolves.toMatchObject({ key: { label: 'seed:sideout:secret:sandbox' } });
  });

  it('seeds one contest per reachable state, idempotently, and the settled one reconciles', async () => {
    const { tenant } = await seedSideoutTenant(database.db);
    await seedPlatformAccounts(database.db, tenant.id);
    await seedRuleset(database.db);
    await seedUsers(database.db, tenant.id as Id<'tnt'>);
    const first = await seedContests(database.db, tenant.id as Id<'tnt'>);
    expect(first.contests.map((c) => [c.externalId, c.state, c.created])).toEqual([
      [SEED_CONTESTS.draft, 'draft', true],
      [SEED_CONTESTS.open, 'open', true],
      [SEED_CONTESTS.awaiting, 'awaiting_settlement', true],
      [SEED_CONTESTS.settled, 'settled', true],
    ]);

    // The awaiting contest holds its four entries in escrow until an operator closes it.
    const awaiting = first.contests.find((c) => c.externalId === SEED_CONTESTS.awaiting);
    const [awaitingRow] = await runtime.db.select().from(contests).where(eq(contests.id, awaiting?.id ?? ''));
    expect(await balanceOf(runtime.db, awaitingRow?.escrowAccountId ?? '')).toBe(400n);
    expect(awaitingRow?.settlementPolicy).toBe('operator_close');

    const open = first.contests.find((c) => c.externalId === SEED_CONTESTS.open);
    const openParticipants = await listParticipants(runtime.db, open?.id ?? '');
    expect(openParticipants.map((p) => p.userId)).toEqual(SEED_USER_IDS.slice(0, 4));
    const [openRow] = await runtime.db.select().from(contests).where(eq(contests.id, open?.id ?? ''));
    expect(await balanceOf(runtime.db, openRow?.escrowAccountId ?? '')).toBe(400n);
    for (const userId of SEED_USER_IDS.slice(0, 4)) {
      const wallet = await findAccount(runtime.db, { tenantId: tenant.id as Id<'tnt'>, kind: 'user_wallet', ownerRef: userId, asset: 'POINTS' });
      // 1000 issued, 100 into the open contest, 100 into the awaiting one, and for the first five also 100 into the settled one plus its payout.
      expect(await balanceOf(runtime.db, wallet?.id ?? '')).toBeGreaterThanOrEqual(700n);
    }

    const settled = first.contests.find((c) => c.externalId === SEED_CONTESTS.settled);
    const results = await listResults(runtime.db, settled?.id ?? '');
    // 21, 18, 18, 15 and a no-show under 50/30/20 of 500: 250, then 150 + 100 shared -> 125 each, 0, 0.
    expect(results.map((r) => [r.placement, r.score, r.payoutAmount])).toEqual([
      [1, 21, 250n],
      [2, 18, 125n],
      [2, 18, 125n],
      [4, 15, 0n],
      [5, null, 0n],
    ]);
    expect(results.reduce((sum, r) => sum + r.payoutAmount, 0n)).toBe(500n);
    const [settledRow] = await runtime.db.select().from(contests).where(eq(contests.id, settled?.id ?? ''));
    expect(await balanceOf(runtime.db, settledRow?.escrowAccountId ?? '')).toBe(0n);
    expect(settledRow?.settledAt).toBeInstanceOf(Date);

    const report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok)).toEqual([]);

    // A second run creates nothing.
    const second = await seedContests(database.db, tenant.id as Id<'tnt'>);
    expect(second.contests.map((c) => [c.id, c.created])).toEqual(first.contests.map((c) => [c.id, false]));
    expect(await database.db.select().from(contests)).toHaveLength(4);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('seeds the console admin once, prints its password only when set, and rotates on request', async () => {
    const first = await seedOperatorAdmin(database.db);
    expect(first.created).toBe(true);
    expect(first.operator).toMatchObject({ email: DEFAULT_OPERATOR_ADMIN_EMAIL, role: 'admin' });
    expect(first.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(await runtime.db.select().from(operators)).toHaveLength(1);
    const signedIn = await signIn(runtime.db, { email: DEFAULT_OPERATOR_ADMIN_EMAIL, password: first.password ?? '' });
    expect(signedIn.operator.id).toBe(first.operator.id);

    // A rerun leaves the account alone and has no password to print.
    const second = await seedOperatorAdmin(database.db);
    expect(second).toMatchObject({ created: false, password: null });
    expect(second.operator.id).toBe(first.operator.id);
    await expect(authenticateSession(runtime.db, signedIn.token)).resolves.toMatchObject({ operator: { id: first.operator.id } });

    // A rotation sets a new password and signs the account out everywhere.
    const rotated = await seedOperatorAdmin(database.db, { rotate: true });
    expect(rotated).toMatchObject({ created: false });
    expect(rotated.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(rotated.password).not.toBe(first.password);
    await expect(signIn(runtime.db, { email: DEFAULT_OPERATOR_ADMIN_EMAIL, password: first.password ?? '' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(signIn(runtime.db, { email: DEFAULT_OPERATOR_ADMIN_EMAIL, password: rotated.password ?? '' })).resolves.toMatchObject({ operator: { id: first.operator.id } });
    await expect(authenticateSession(runtime.db, signedIn.token)).rejects.toMatchObject({ code: 'session_revoked' });
    expect(await runtime.db.select().from(operatorSessions).where(eq(operatorSessions.operatorId, first.operator.id))).toHaveLength(2);

    // A custom email is honoured and normalised.
    const custom = await seedOperatorAdmin(database.db, { email: 'Ops@Example.COM' });
    expect(custom.operator.email).toBe('ops@example.com');
    expect(await runtime.db.select().from(operators)).toHaveLength(2);
    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.action, 'operator.created'));
    expect(audit).toHaveLength(2);
    expect(audit.every((row) => row.actorKind === 'operator' && row.actorRef === 'seed' && JSON.stringify(row.after).includes('passwordHash') === false)).toBe(true);
  });
});
