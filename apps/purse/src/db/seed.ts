import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import { createApiKey, revokeApiKey, type CreatedApiKey } from '../auth/api-keys';
import { closeContest, createContest, enterContest, getContest, previewSettlement, submitScores, transition } from '../contests';
import { publishRuleset, SPEC_EXAMPLE_RULESET } from '../eligibility';
import { activeOrigins, addOrigin } from '../embed/origins';
import { findAccount, openAccount } from '../ledger/accounts';
import type { Actor } from '../ledger/audit';
import { issuePromoPoints } from '../ledger/flows';
import { devIdentityProvider } from '../providers';
import { addRestriction, getVerification, recordLocation, refreshFingerprint, startVerification } from '../users';
import type { Db, DbOrTx } from './client';
import {
  apiKeys,
  asset,
  contests,
  tenants,
  userVerification,
  users,
  type Account,
  type AccountKind,
  type ApiKey,
  type Contest,
  type RulesetRow,
  type Tenant,
  type User,
} from './schema';

/**
 * Reference data Purse cannot run without, applied by `pnpm db:seed` after migrations.
 * Seed data never lives in migration history: migrations are forward-only and describe
 * the schema, this describes rows, and it may be re-run against any environment.
 *
 * Sideout's tenant id is a UUID v7 minted once so every environment agrees on it; phase 4
 * configures Sideout with the same value through its own environment, not by importing
 * this file.
 */
export const SIDEOUT_TENANT_ID: Id<'tnt'> = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9';
export const SIDEOUT_TENANT_NAME = 'Sideout';

export type SeedResult = { tenant: Tenant; created: boolean };

/**
 * Upsert the Sideout tenant, keyed on its unique name. A first run inserts the row with
 * the stable id; a later run leaves whatever is there alone (including an operator's
 * suspension) and reports it, so the script is safe to run on every deploy.
 */
export async function seedSideoutTenant(db: Db): Promise<SeedResult> {
  const [inserted] = await db
    .insert(tenants)
    .values({ id: SIDEOUT_TENANT_ID, name: SIDEOUT_TENANT_NAME })
    .onConflictDoNothing({ target: tenants.name })
    .returning();
  if (inserted !== undefined) return { tenant: inserted, created: true };

  const [existing] = await db.select().from(tenants).where(eq(tenants.name, SIDEOUT_TENANT_NAME));
  if (existing === undefined) {
    throw new Error(`Tenant "${SIDEOUT_TENANT_NAME}" was neither inserted nor found`);
  }
  return { tenant: existing, created: false };
}

/**
 * The platform-level accounts every tenant has, one per asset (spec 4.2.1): the promo
 * liability points are issued from, the platform fee account (zero in v1 but modelled),
 * and the external settlement boundary redemptions leave through. `openAccount` is
 * idempotent on the unique key, so this creates nothing on a second run. User wallets and
 * contest escrows are opened on demand, never seeded.
 */
export const PLATFORM_ACCOUNT_KINDS: readonly AccountKind[] = ['promo_liability', 'platform_fee', 'external_settlement'];

export type PlatformAccountsResult = { accounts: Account[]; created: number };

export async function seedPlatformAccounts(db: Db, tenantId: string): Promise<PlatformAccountsResult> {
  const opened: Account[] = [];
  let created = 0;
  for (const kind of PLATFORM_ACCOUNT_KINDS) {
    for (const each of asset.enumValues) {
      const result = await openAccount(db, { tenantId: tenantId as Id<'tnt'>, kind, ownerRef: null, asset: each });
      opened.push(result.account);
      if (result.created) created += 1;
    }
  }
  return { accounts: opened, created };
}

// ---- Ruleset (phase 3) ---------------------------------------------------------------

/** The spec 4.5 example is the first active version. Stored once; a rerun finds it. */
export async function seedRuleset(db: Db): Promise<{ ruleset: RulesetRow; created: boolean }> {
  return publishRuleset(db, { body: SPEC_EXAMPLE_RULESET, activate: true });
}

// ---- Users (phase 3) -----------------------------------------------------------------

/**
 * Six users the seed contests are played by. Stable ids, like the tenant's, so every
 * environment agrees, and stable external ids the way a partner would link them. Their
 * wallets are funded with promo points through the ledger like anyone else's.
 *
 * Between them they exercise every verification state (acceptance criterion 29) and the
 * risk controls: three verified (demographics supplied, permitted regions), one left
 * pending by the dev identity provider, one rejected by it, one who has never started and
 * has excluded themself; the last two share a name and date of birth, which raises the
 * duplicate-identity flag the operator console reviews.
 */
export const SEED_USER_IDS: ReadonlyArray<Id<'usr'>> = [
  'usr_01a0b278-93be-70eb-9f0e-c4bfefda6f93',
  'usr_01a0b278-93be-70eb-9f0e-cbd06cb6e1b0',
  'usr_01a0b278-93be-70eb-9f0e-ce4de28b996c',
  'usr_01a0b278-93be-70eb-9f0e-d35624fd293e',
  'usr_01a0b278-93be-70eb-9f0e-d790d453c2f0',
  'usr_01a0b278-93be-70eb-9f0e-da1121d7a116',
];

export type SeedUser = {
  id: Id<'usr'>;
  externalId: string;
  displayName: string;
  dateOfBirth: string;
  phoneE164: string;
  region: string | null;
  /** What the dev identity provider is seeded to answer, and what the seed drives the user to. */
  verification: 'verified' | 'pending' | 'rejected' | 'unstarted';
  selfExcluded?: boolean;
};

export const SEED_USERS: readonly SeedUser[] = [
  { id: SEED_USER_IDS[0] ?? 'usr_', externalId: 'seed:user-1', displayName: 'Ana Reyes', dateOfBirth: '1994-03-12', phoneE164: '+15125550101', region: 'US-TX', verification: 'verified' },
  { id: SEED_USER_IDS[1] ?? 'usr_', externalId: 'seed:user-2', displayName: 'Marcus Lee', dateOfBirth: '1991-07-30', phoneE164: '+13105550102', region: 'US-CA', verification: 'verified' },
  { id: SEED_USER_IDS[2] ?? 'usr_', externalId: 'seed:user-3', displayName: 'Priya Natarajan', dateOfBirth: '1998-11-05', phoneE164: '+19195550103', region: 'US-NC', verification: 'verified' },
  { id: SEED_USER_IDS[3] ?? 'usr_', externalId: 'seed:user-4', displayName: 'Diego Alvarez', dateOfBirth: '1989-01-22', phoneE164: '+17135550104', region: null, verification: 'pending' },
  { id: SEED_USER_IDS[4] ?? 'usr_', externalId: 'seed:user-5', displayName: 'Sam Okafor', dateOfBirth: '1996-09-09', phoneE164: '+12125550105', region: 'US-NY', verification: 'rejected' },
  { id: SEED_USER_IDS[5] ?? 'usr_', externalId: 'seed:user-6', displayName: 'Sam Okafor', dateOfBirth: '1996-09-09', phoneE164: '+12125550106', region: 'US-NY', verification: 'unstarted', selfExcluded: true },
];

/** The dev identity provider as the seed drives it: the same lists `DEV_IDENTITY_*` would carry. */
export const SEED_IDENTITY_LISTS = {
  allow: SEED_USERS.filter((user) => user.verification === 'verified').map((user) => user.externalId),
  deny: SEED_USERS.filter((user) => user.verification === 'rejected').map((user) => user.externalId),
  pending: SEED_USERS.filter((user) => user.verification === 'pending').map((user) => user.externalId),
};

export const SEED_SELF_EXCLUSION_DAYS = 30;

export type SeedUsersResult = { users: Array<{ id: string; externalId: string; verification: string; created: boolean }>; duplicateFlags: number };

/**
 * Upsert the six users by their stable ids (a phase 2 database has placeholder rows for
 * them from the migration backfill), then bring each to its verification state through
 * the same state machine the API runs, record locations, fingerprints and the one
 * self-exclusion. Every step is idempotent: a rerun changes nothing.
 */
export async function seedUsers(db: Db, tenantId: Id<'tnt'>): Promise<SeedUsersResult> {
  const identity = devIdentityProvider(SEED_IDENTITY_LISTS);
  const results: SeedUsersResult['users'] = [];
  let duplicateFlags = 0;
  for (const seed of SEED_USERS) {
    const { user, created } = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.id, seed.id));
      const [row] = await tx
        .insert(users)
        .values({ id: seed.id, tenantId, externalId: seed.externalId, displayName: seed.displayName, dateOfBirth: seed.dateOfBirth, phoneE164: seed.phoneE164 })
        .onConflictDoUpdate({
          target: users.id,
          set: { externalId: seed.externalId, displayName: seed.displayName, dateOfBirth: seed.dateOfBirth, phoneE164: seed.phoneE164, updatedAt: sql`now()` },
        })
        .returning();
      if (row === undefined) throw new Error(`users upsert of ${seed.id} returned no row`);
      await tx.insert(userVerification).values({ userId: row.id }).onConflictDoNothing({ target: userVerification.userId });
      const { flags } = await refreshFingerprint(tx, row);
      duplicateFlags += flags.length;
      if (seed.region !== null) {
        await recordLocation(tx, { user: row, resolution: { region: seed.region, confidence: 0.6, source: 'declared' }, actor: SEED_OPERATOR });
      }
      return { user: row, created: existing?.externalId !== seed.externalId };
    });

    const verification = await getVerification(db, user.id);
    if (seed.verification !== 'unstarted' && verification.state === 'unstarted') {
      await startVerification(db, { tenantId, userId: user.id, identity, actor: SEED_OPERATOR });
    }
    if (seed.selfExcluded === true) await seedSelfExclusion(db, tenantId, user);

    results.push({ id: user.id, externalId: user.externalId, verification: (await getVerification(db, user.id)).state, created });
  }
  return { users: results, duplicateFlags };
}

async function seedSelfExclusion(db: Db, tenantId: Id<'tnt'>, user: User): Promise<void> {
  const [active] = await db.execute<{ id: string }>(sql`
    select id from user_restrictions
    where user_id = ${user.id} and kind = 'self_exclusion' and lifted_at is null and (ends_at is null or ends_at > now())
    limit 1
  `);
  if (active !== undefined) return;
  await addRestriction(db, {
    tenantId,
    userId: user.id,
    kind: 'self_exclusion',
    reason: 'seed: self-excluded for a month',
    endsAt: new Date(Date.now() + SEED_SELF_EXCLUSION_DAYS * 86_400_000),
    actor: { kind: 'user', ref: user.id },
  });
}

// ---- API keys (phase 3) --------------------------------------------------------------

/**
 * One sandbox secret key with the operator scope (Sideout's server issues credits and
 * closes tournaments with it) and one sandbox publishable key (the iframe bootstrap),
 * labelled so a rerun finds them. The plaintext exists only in the return value of the run
 * that created a key; `pnpm db:seed -- --print-keys` prints it then and never again, and
 * `--rotate-keys` revokes the seed keys and mints new ones.
 */
export const SEED_API_KEYS = [
  { label: 'seed:sideout:secret:sandbox', kind: 'secret', environment: 'sandbox', scopes: ['operator'] },
  { label: 'seed:sideout:publishable:sandbox', kind: 'publishable', environment: 'sandbox', scopes: [] },
] as const;

export type SeedApiKeysResult = { keys: Array<{ key: Omit<ApiKey, 'keyHash'>; plaintext: string | null; created: boolean }> };

export async function seedApiKeys(db: Db, tenantId: Id<'tnt'>, options: { rotate?: boolean } = {}): Promise<SeedApiKeysResult> {
  const keys: SeedApiKeysResult['keys'] = [];
  for (const spec of SEED_API_KEYS) {
    const created = await db.transaction(async (tx): Promise<{ key: ApiKey; plaintext: string | null; created: boolean }> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seed-api-key:${tenantId}:${spec.label}`}, 0))`);
      const [existing] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.label, spec.label), isNull(apiKeys.revokedAt)));
      if (existing !== undefined && options.rotate !== true) return { key: existing, plaintext: null, created: false };
      if (existing !== undefined) await revokeApiKey(tx, { tenantId, keyId: existing.id, actor: SEED_OPERATOR });
      const made: CreatedApiKey = await createApiKey(tx, { tenantId, kind: spec.kind, environment: spec.environment, scopes: [...spec.scopes], label: spec.label, actor: SEED_OPERATOR });
      return { key: made.key, plaintext: made.plaintext, created: true };
    });
    const { keyHash: _hash, ...key } = created.key;
    keys.push({ key, plaintext: created.plaintext, created: created.created });
  }
  return { keys };
}

// ---- Embed origins (phase 4) ---------------------------------------------------------

/**
 * The origins Sideout's pages mount Purse flows from (spec 4.8 rule 3): the local dev
 * server by default, plus whatever `PURSE_TENANT_ORIGINS` (comma-separated) names for a
 * hosted environment, so a deploy registers `https://sideout.<domain>` by seeding rather
 * than by hand. Idempotent; a revoked origin that is still listed here is restored.
 */
export const SEED_TENANT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'] as const;

export type SeedOriginsResult = { origins: string[]; created: number };

export async function seedTenantOrigins(db: Db, tenantId: Id<'tnt'>, extra: readonly string[] = []): Promise<SeedOriginsResult> {
  const before = new Set(await activeOrigins(db, tenantId));
  let created = 0;
  for (const origin of [...SEED_TENANT_ORIGINS, ...extra]) {
    const added = await addOrigin(db, { tenantId, origin, actor: SEED_OPERATOR });
    if (!before.has(added.origin)) created += 1;
  }
  return { origins: await activeOrigins(db, tenantId), created };
}

// ---- Contests (phase 2) --------------------------------------------------------------

export const SEED_PROMO_POINTS = 1000n;
export const SEED_ENTRY_AMOUNT = 100n;

/** The actor the seed's operator actions are recorded under. */
export const SEED_OPERATOR: Actor = { kind: 'operator', ref: 'seed' };

export const SEED_CONTESTS = {
  draft: 'seed-draft-doubles',
  open: 'seed-open-doubles',
  settled: 'seed-settled-doubles',
} as const;

export type SeedContestsResult = { contests: Array<{ externalId: string; id: string; state: string; created: boolean }> };

/**
 * One contest per state the seed can reach without scores from Sideout: a `draft`, an
 * `open` with four entered users holding promo points, and a `settled` one whose results
 * reconcile (I4, I5, I7), so the console phase has data to show. Each is keyed on its
 * `external_id` and built in one transaction through the same services the API uses, so
 * a rerun creates nothing and a partial run leaves nothing behind.
 */
export async function seedContests(db: Db, tenantId: Id<'tnt'>): Promise<SeedContestsResult> {
  const results: SeedContestsResult['contests'] = [];
  for (const [state, externalId] of Object.entries(SEED_CONTESTS) as Array<[keyof typeof SEED_CONTESTS, string]>) {
    const [existing] = await db.select().from(contests).where(and(eq(contests.tenantId, tenantId), eq(contests.externalId, externalId)));
    if (existing !== undefined) {
      results.push({ externalId, id: existing.id, state: existing.state, created: false });
      continue;
    }
    const built = await db.transaction(async (tx) => {
      switch (state) {
        case 'draft':
          return seedDraftContest(tx, tenantId, externalId);
        case 'open':
          return seedOpenContest(tx, tenantId, externalId);
        case 'settled':
          return seedSettledContest(tx, tenantId, externalId);
      }
    });
    results.push({ externalId, id: built.id, state: built.state, created: true });
  }
  return { contests: results };
}

async function seedDraftContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: Saturday doubles (draft)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    maxParticipants: 16,
    prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  return contest;
}

async function seedOpenContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: Sunday doubles (open)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    maxParticipants: 16,
    prizeStructure: { type: 'top_n_equal', n: 3 },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR, reason: 'seed' });
  const entrants = SEED_USER_IDS.slice(0, 4);
  await fundWallets(tx, tenantId, entrants);
  for (const userId of entrants) {
    await enterContest(tx, { tenantId, contestId: contest.id, userId, idempotencyKey: `seed:enter:${externalId}:${userId}`, actor: SEED_OPERATOR });
  }
  return getContest(tx, tenantId, contest.id);
}

async function seedSettledContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: opening weekend doubles (settled)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR, reason: 'seed' });
  const entrants = SEED_USER_IDS.slice(0, 5);
  await fundWallets(tx, tenantId, entrants);
  for (const userId of entrants) {
    await enterContest(tx, { tenantId, contestId: contest.id, userId, idempotencyKey: `seed:enter:${externalId}:${userId}`, actor: SEED_OPERATOR });
  }
  await transition(tx, { tenantId, contestId: contest.id, to: 'locked', actor: SEED_OPERATOR, reason: 'seed' });
  await transition(tx, { tenantId, contestId: contest.id, to: 'in_progress', actor: SEED_OPERATOR, reason: 'seed' });
  // Five entrants, one tie for second: 21, 18, 18, 15 and a no-show, all attempts finished,
  // which is what moves the contest to awaiting_settlement.
  const scores = [21, 18, 18, 15, null];
  await submitScores(tx, {
    tenantId,
    contestId: contest.id,
    scores: entrants.map((userId, index) => ({ userId, score: scores[index] ?? null, attemptFinished: true, sourceRef: `seed:match:${index + 1}` })),
    idempotencyKey: `seed:scores:${externalId}`,
    actor: SEED_OPERATOR,
  });
  const preview = await previewSettlement(tx, { tenantId, contestId: contest.id });
  const closed = await closeContest(tx, {
    tenantId,
    contestId: contest.id,
    payoutHash: preview.payoutHash,
    actor: SEED_OPERATOR,
    idempotencyKey: `seed:close:${externalId}`,
  });
  return closed.contest;
}

/** Issue every user's promo points once (the ledger's idempotency makes a rerun a no-op) so they can afford to enter. */
async function fundWallets(tx: DbOrTx, tenantId: Id<'tnt'>, userIds: ReadonlyArray<Id<'usr'>>): Promise<void> {
  const promo = await findAccount(tx, { tenantId, kind: 'promo_liability', ownerRef: null, asset: 'POINTS' });
  if (promo === undefined) throw new Error('promo_liability account missing; run seedPlatformAccounts first');
  for (const userId of userIds) {
    const { account: wallet } = await openAccount(tx, { tenantId, kind: 'user_wallet', ownerRef: userId, asset: 'POINTS' });
    await issuePromoPoints(tx, {
      tenantId,
      asset: 'POINTS',
      promoLiabilityAccountId: promo.id,
      walletAccountId: wallet.id,
      amount: SEED_PROMO_POINTS,
      idempotencyKey: `seed:issue:${userId}`,
      description: `Seed promo points for ${userId}`,
    });
  }
}
