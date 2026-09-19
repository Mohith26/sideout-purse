import { eq } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { Database, DbOrTx } from '../../src/db/client';
import {
  accounts,
  apiKeys,
  auditLog,
  contestParticipants,
  contestResults,
  contestScores,
  contests,
  eligibilityDecisions,
  embedSigninCodes,
  embedTokens,
  idempotencyKeys,
  idempotencyReservations,
  identityFingerprints,
  journalEntries,
  journalLines,
  operatorFlags,
  operatorSessions,
  operators,
  reconcileRuns,
  rulesets,
  tenantOrigins,
  tenants,
  userLocations,
  userRestrictions,
  userVerification,
  users,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  type Account,
  type AccountKind,
  type Asset,
  type User,
  userDevices,
} from '../../src/db/schema';
import { openAccount } from '../../src/ledger';

/**
 * Ledger test fixtures. Rows are created through the same code the platform uses
 * (`openAccount`), through whichever connection the test hands in; wiping is the one
 * thing only the owner role can do, so `wipeLedger` takes the migrator connection.
 * A wallet needs a user (phase 3 made `accounts.user_id` a foreign key), so `openWallet`
 * creates one when handed an id it has not seen.
 */

/** Delete every ledger, contest and identity row, in foreign-key order. Owner role only. */
export async function wipeLedger(migrator: Database): Promise<void> {
  await migrator.db.delete(webhookDeliveryAttempts);
  await migrator.db.delete(webhookDeliveries);
  await migrator.db.delete(webhookEndpoints);
  await migrator.db.delete(embedSigninCodes);
  await migrator.db.delete(tenantOrigins);
  await migrator.db.delete(eligibilityDecisions);
  await migrator.db.delete(embedTokens);
  await migrator.db.delete(operatorFlags);
  await migrator.db.delete(identityFingerprints);
  await migrator.db.delete(userLocations);
  await migrator.db.delete(userRestrictions);
  await migrator.db.delete(userDevices);
  await migrator.db.delete(contestResults);
  await migrator.db.delete(contestScores);
  await migrator.db.delete(contestParticipants);
  await migrator.db.delete(journalLines);
  await migrator.db.delete(journalEntries);
  await migrator.db.delete(contests);
  await migrator.db.delete(rulesets);
  await migrator.db.delete(idempotencyKeys);
  await migrator.db.delete(idempotencyReservations);
  await migrator.db.delete(auditLog);
  await migrator.db.delete(accounts);
  await migrator.db.delete(userVerification);
  await migrator.db.delete(users);
  await migrator.db.delete(apiKeys);
  await migrator.db.delete(tenants);
  await migrator.db.delete(operatorSessions);
  await migrator.db.delete(operators);
  await migrator.db.delete(reconcileRuns);
}

export type CreateUserOptions = {
  id?: Id<'usr'>;
  externalId?: string;
  displayName?: string | null;
  dateOfBirth?: string | null;
  phoneE164?: string | null;
};

/** A bare user row (and its `unstarted` verification row), the way the identity services would have made it. */
export async function createUser(db: DbOrTx, tenantId: Id<'tnt'>, options: CreateUserOptions = {}): Promise<User> {
  const id = options.id ?? newId('usr');
  const [row] = await db
    .insert(users)
    .values({
      id,
      tenantId,
      externalId: options.externalId ?? `ext-${id.slice(4)}`,
      displayName: options.displayName === undefined ? `User ${id.slice(-6)}` : options.displayName,
      dateOfBirth: options.dateOfBirth === undefined ? '1990-01-01' : options.dateOfBirth,
      phoneE164: options.phoneE164 ?? null,
    })
    .onConflictDoNothing({ target: users.id })
    .returning();
  await db.insert(userVerification).values({ userId: id }).onConflictDoNothing({ target: userVerification.userId });
  if (row !== undefined) return row;
  const [existing] = await db.select().from(users).where(eq(users.id, id));
  if (existing === undefined) throw new Error(`user ${id} was neither inserted nor found`);
  return existing;
}

export async function createTenant(db: DbOrTx, name?: string): Promise<Id<'tnt'>> {
  const id = newId('tnt');
  name ??= `tenant-${id.slice(4)}`;
  await db.insert(tenants).values({ id, name });
  return id;
}

export async function openPlatform(db: DbOrTx, tenantId: Id<'tnt'>, kind: AccountKind, asset: Asset = 'POINTS'): Promise<Account> {
  return (await openAccount(db, { tenantId, kind, ownerRef: null, asset })).account;
}

export async function openWallet(db: DbOrTx, tenantId: Id<'tnt'>, asset: Asset = 'POINTS', userId: Id<'usr'> = newId('usr')): Promise<Account> {
  await createUser(db, tenantId, { id: userId });
  return (await openAccount(db, { tenantId, kind: 'user_wallet', ownerRef: userId, asset })).account;
}

export async function openEscrow(db: DbOrTx, tenantId: Id<'tnt'>, asset: Asset = 'POINTS', contestId = newId('cnt')): Promise<Account> {
  return (await openAccount(db, { tenantId, kind: 'contest_escrow', ownerRef: contestId, asset })).account;
}

/**
 * A bare contest row for an escrow account, so a ledger test can post entries that carry a
 * `contest_id` (a real foreign key from phase 2). The contest engine's own tests build
 * contests through `createContest`; this is only for ledger tests that need the id.
 */
export async function contestFor(db: DbOrTx, tenantId: Id<'tnt'>, escrow: Account): Promise<Id<'cnt'>> {
  const id = escrow.ownerRef as Id<'cnt'>;
  await db
    .insert(contests)
    .values({
      id,
      tenantId,
      externalId: `ledger-test-${id}`,
      kind: 'head_to_head',
      title: 'ledger fixture',
      asset: escrow.asset,
      entryAmount: 1n,
      prizeStructure: { type: 'winner_take_all' },
      escrowAccountId: escrow.id,
    })
    .onConflictDoNothing({ target: contests.id });
  return id;
}

/** A tenant with the accounts the standard flows need, in one asset. */
export type World = {
  tenantId: Id<'tnt'>;
  asset: Asset;
  promo: Account;
  sponsor: Account;
  fee: Account;
  wallets: Account[];
  escrows: Account[];
};

export async function buildWorld(db: DbOrTx, options: { wallets: number; escrows: number; asset?: Asset }): Promise<World> {
  const asset = options.asset ?? 'POINTS';
  const tenantId = await createTenant(db);
  const promo = await openPlatform(db, tenantId, 'promo_liability', asset);
  const sponsor = await openPlatform(db, tenantId, 'sponsor_funding', asset);
  const fee = await openPlatform(db, tenantId, 'platform_fee', asset);
  const wallets: Account[] = [];
  for (let i = 0; i < options.wallets; i += 1) wallets.push(await openWallet(db, tenantId, asset));
  const escrows: Account[] = [];
  for (let i = 0; i < options.escrows; i += 1) escrows.push(await openEscrow(db, tenantId, asset));
  return { tenantId, asset, promo, sponsor, fee, wallets, escrows };
}

let keyCounter = 0;

/** A fresh idempotency key. Tests that want a collision reuse the string they got. */
export function key(label = 'k'): string {
  keyCounter += 1;
  return `${label}-${process.pid}-${Date.now().toString(36)}-${keyCounter}`;
}

/** A small deterministic PRNG (mulberry32) so a randomized run can be replayed from its seed. */
export function rng(seed: number): { next(): number; int(maxExclusive: number): number; pick<T>(items: readonly T[]): T; bigint(min: bigint, max: bigint): bigint } {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
    // Uniform-ish over [min, max]; ranges in these tests are far below 2^53 so the double is exact.
    bigint: (min, max) => min + BigInt(Math.floor(next() * Number(max - min + 1n))),
  };
}
