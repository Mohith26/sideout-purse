import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import { createApiKey, revokeApiKey, type CreatedApiKey } from '../auth/api-keys';
import { closeContest, createContest, enterContest, getContest, previewSettlement, submitScores, transition, voidContest } from '../contests';
import { publishRuleset, SPEC_EXAMPLE_RULESET } from '../eligibility';
import { activeOrigins, addOrigin } from '../embed/origins';
import { findAccount, openAccount } from '../ledger/accounts';
import type { Actor } from '../ledger/audit';
import { issuePromoPoints } from '../ledger/flows';
import { createOperator, generatePassword, revokeOtherSessions, setPassword } from '../operators';
import { devFundingProvider, devIdentityProvider } from '../providers';
import { addPaymentMethod, confirmPayment, deposit, listPaymentMethods, requestWithdrawal } from '../treasury';
import { addRestriction, getVerification, recordLocation, refreshFingerprint, startVerification } from '../users';
import type { Db, DbOrTx } from './client';
import {
  apiKeys,
  asset,
  contests,
  operators,
  tenants,
  userVerification,
  users,
  type Account,
  type AccountKind,
  type ApiKey,
  type ApiKeyScope,
  type Contest,
  type Operator,
  type RulesetRow,
  type Tenant,
  type User,
} from './schema';

/**
 * Reference data Purse cannot run without, applied by `pnpm db:seed` after migrations.
 * Seed data never lives in migration history: migrations are forward-only and describe
 * the schema, this describes rows, and it may be re-run against any environment.
 *
 * Two tenants are seeded: Sideout, and the ping-pong ladder (system spec section 12,
 * stretch item 4; docs/second-tenant.md). Each tenant id is a UUID v7 minted once so every
 * environment agrees on it; each product is configured with its value through its own
 * environment, not by importing this file. A tenant is a name, a stable id, the local dev
 * origins its pages mount Purse flows from, and the label its seed keys carry.
 */
export type SeedTenant = {
  id: Id<'tnt'>;
  name: string;
  /** The label prefix of the tenant's seed keys: `seed:<slug>:secret:sandbox`. */
  slug: string;
  /** The origins the tenant's local dev server runs on (spec 4.8 rule 3). */
  devOrigins: readonly string[];
  /** The environment variable naming the tenant's deployed origin(s), comma-separated. */
  originsVariable: string;
};

export const SIDEOUT_TENANT_ID: Id<'tnt'> = 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9';
export const SIDEOUT_TENANT_NAME = 'Sideout';
export const PINGPONG_TENANT_ID: Id<'tnt'> = 'tnt_01a0c2f0-5e7a-7b4e-9d1a-4f2b8c6d0e11';
export const PINGPONG_TENANT_NAME = 'Ping-pong';

export const SIDEOUT_TENANT: SeedTenant = { id: SIDEOUT_TENANT_ID, name: SIDEOUT_TENANT_NAME, slug: 'sideout', devOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'], originsVariable: 'PURSE_TENANT_ORIGINS' };
export const PINGPONG_TENANT: SeedTenant = { id: PINGPONG_TENANT_ID, name: PINGPONG_TENANT_NAME, slug: 'pingpong', devOrigins: ['http://localhost:3100', 'http://127.0.0.1:3100'], originsVariable: 'PURSE_PINGPONG_ORIGINS' };
/** Every seeded tenant, Sideout first. */
export const SEED_TENANTS: readonly SeedTenant[] = [SIDEOUT_TENANT, PINGPONG_TENANT];

export type SeedResult = { tenant: Tenant; created: boolean };

/**
 * Upsert a tenant, keyed on its unique name. A first run inserts the row with the stable
 * id; a later run leaves whatever is there alone (including an operator's suspension) and
 * reports it, so the script is safe to run on every deploy.
 */
export async function seedTenant(db: Db, spec: Pick<SeedTenant, 'id' | 'name'>): Promise<SeedResult> {
  const [inserted] = await db.insert(tenants).values({ id: spec.id, name: spec.name }).onConflictDoNothing({ target: tenants.name }).returning();
  if (inserted !== undefined) return { tenant: inserted, created: true };

  const [existing] = await db.select().from(tenants).where(eq(tenants.name, spec.name));
  if (existing === undefined) {
    throw new Error(`Tenant "${spec.name}" was neither inserted nor found`);
  }
  return { tenant: existing, created: false };
}

/** The Sideout tenant (the first; the seed contests and users are its). */
export function seedSideoutTenant(db: Db): Promise<SeedResult> {
  return seedTenant(db, SIDEOUT_TENANT);
}

/** The ping-pong tenant: the second consumer, with its own keys, origins and platform accounts and nothing else seeded. */
export function seedPingpongTenant(db: Db): Promise<SeedResult> {
  return seedTenant(db, PINGPONG_TENANT);
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
 * Seven users the seed contests are played by. Stable ids, like the tenant's, so every
 * environment agrees, and stable external ids the way a partner would link them. Their
 * wallets are funded with promo points through the ledger like anyone else's.
 *
 * Between them they exercise every verification state (acceptance criterion 29) and the
 * risk controls: three verified (demographics supplied, permitted regions), one left
 * pending by the dev identity provider, one rejected by it, one who has never started and
 * has excluded themself, and one verified player an operator has blocked from the platform
 * (`platform_block`, the `platform_blocked` refusal). The fifth and sixth share a name and
 * date of birth, which raises the duplicate-identity flag the operator console reviews.
 */
export const SEED_USER_IDS: ReadonlyArray<Id<'usr'>> = [
  'usr_01a0b278-93be-70eb-9f0e-c4bfefda6f93',
  'usr_01a0b278-93be-70eb-9f0e-cbd06cb6e1b0',
  'usr_01a0b278-93be-70eb-9f0e-ce4de28b996c',
  'usr_01a0b278-93be-70eb-9f0e-d35624fd293e',
  'usr_01a0b278-93be-70eb-9f0e-d790d453c2f0',
  'usr_01a0b278-93be-70eb-9f0e-da1121d7a116',
  'usr_01a0b278-93be-70eb-9f0e-e07c3a5d2b41',
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
  /** An operator has blocked this account from the platform (`platform_block`, no end date). */
  platformBlocked?: boolean;
};

export const SEED_USERS: readonly SeedUser[] = [
  { id: SEED_USER_IDS[0] ?? 'usr_', externalId: 'seed:user-1', displayName: 'Ana Reyes', dateOfBirth: '1994-03-12', phoneE164: '+15125550101', region: 'US-TX', verification: 'verified' },
  { id: SEED_USER_IDS[1] ?? 'usr_', externalId: 'seed:user-2', displayName: 'Marcus Lee', dateOfBirth: '1991-07-30', phoneE164: '+13105550102', region: 'US-CA', verification: 'verified' },
  { id: SEED_USER_IDS[2] ?? 'usr_', externalId: 'seed:user-3', displayName: 'Priya Natarajan', dateOfBirth: '1998-11-05', phoneE164: '+19195550103', region: 'US-NC', verification: 'verified' },
  { id: SEED_USER_IDS[3] ?? 'usr_', externalId: 'seed:user-4', displayName: 'Diego Alvarez', dateOfBirth: '1989-01-22', phoneE164: '+17135550104', region: null, verification: 'pending' },
  { id: SEED_USER_IDS[4] ?? 'usr_', externalId: 'seed:user-5', displayName: 'Sam Okafor', dateOfBirth: '1996-09-09', phoneE164: '+12125550105', region: 'US-NY', verification: 'rejected' },
  { id: SEED_USER_IDS[5] ?? 'usr_', externalId: 'seed:user-6', displayName: 'Sam Okafor', dateOfBirth: '1996-09-09', phoneE164: '+12125550106', region: 'US-NY', verification: 'unstarted', selfExcluded: true },
  { id: SEED_USER_IDS[6] ?? 'usr_', externalId: 'seed:user-7', displayName: 'Jordan Blake', dateOfBirth: '1990-05-17', phoneE164: '+13235550107', region: 'US-CA', verification: 'verified', platformBlocked: true },
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
 * Upsert the seven users by their stable ids (a phase 2 database has placeholder rows for
 * the first six from the migration backfill), then bring each to its verification state
 * through the same state machine the API runs, record locations, fingerprints, the one
 * self-exclusion and the one platform block. Every step is idempotent: a rerun changes
 * nothing.
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
    if (seed.platformBlocked === true) await seedPlatformBlock(db, tenantId, user);

    results.push({ id: user.id, externalId: user.externalId, verification: (await getVerification(db, user.id)).state, created });
  }
  return { users: results, duplicateFlags };
}

async function activeRestriction(db: Db, userId: string, kind: 'self_exclusion' | 'platform_block'): Promise<boolean> {
  const [active] = await db.execute<{ id: string }>(sql`
    select id from user_restrictions
    where user_id = ${userId} and kind = ${kind} and lifted_at is null and (ends_at is null or ends_at > now())
    limit 1
  `);
  return active !== undefined;
}

async function seedSelfExclusion(db: Db, tenantId: Id<'tnt'>, user: User): Promise<void> {
  if (await activeRestriction(db, user.id, 'self_exclusion')) return;
  await addRestriction(db, {
    tenantId,
    userId: user.id,
    kind: 'self_exclusion',
    reason: 'seed: self-excluded for a month',
    endsAt: new Date(Date.now() + SEED_SELF_EXCLUSION_DAYS * 86_400_000),
    actor: { kind: 'user', ref: user.id },
  });
}

/** The operator's block: a verified identity the platform still refuses (`platform_blocked`), with no end date. */
async function seedPlatformBlock(db: Db, tenantId: Id<'tnt'>, user: User): Promise<void> {
  if (await activeRestriction(db, user.id, 'platform_block')) return;
  await addRestriction(db, {
    tenantId,
    userId: user.id,
    kind: 'platform_block',
    reason: 'seed: blocked by an operator after a chargeback dispute',
    actor: SEED_OPERATOR,
  });
}

// ---- API keys (phase 3) --------------------------------------------------------------

/**
 * Per tenant, one sandbox secret key with the operator scope (the product's server issues
 * credits and closes contests with it) and one sandbox publishable key (the iframe
 * bootstrap), labelled `seed:<slug>:...` so a rerun finds them. The plaintext exists only
 * in the return value of the run that created a key; `pnpm db:seed -- --print-keys` prints
 * it then and never again, and `--rotate-keys` revokes the seed keys and mints new ones.
 */
export type SeedApiKeySpec = { label: string; kind: 'secret' | 'publishable'; environment: 'sandbox'; scopes: readonly ApiKeyScope[] };

export function seedApiKeySpecs(slug: string): readonly SeedApiKeySpec[] {
  return [
    { label: `seed:${slug}:secret:sandbox`, kind: 'secret', environment: 'sandbox', scopes: ['operator'] },
    { label: `seed:${slug}:publishable:sandbox`, kind: 'publishable', environment: 'sandbox', scopes: [] },
  ];
}

/** Sideout's two seed keys. */
export const SEED_API_KEYS = seedApiKeySpecs(SIDEOUT_TENANT.slug);

export type SeedApiKeysResult = { keys: Array<{ key: Omit<ApiKey, 'keyHash'>; plaintext: string | null; created: boolean }> };

export async function seedApiKeys(db: Db, tenantId: Id<'tnt'>, options: { rotate?: boolean; slug?: string } = {}): Promise<SeedApiKeysResult> {
  const keys: SeedApiKeysResult['keys'] = [];
  for (const spec of seedApiKeySpecs(options.slug ?? SIDEOUT_TENANT.slug)) {
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
 * The origins a tenant's pages mount Purse flows from (spec 4.8 rule 3): its local dev
 * server by default, plus whatever its origins variable (`PURSE_TENANT_ORIGINS` for
 * Sideout, `PURSE_PINGPONG_ORIGINS` for the ladder; comma-separated) names for a hosted
 * environment, so a deploy registers `https://sideout.<domain>` by seeding rather than by
 * hand. Idempotent; a revoked origin that is still listed here is restored.
 */
export const SEED_TENANT_ORIGINS = SIDEOUT_TENANT.devOrigins;

export type SeedOriginsResult = { origins: string[]; created: number };

/** The comma-separated origins a tenant's variable names in `source`, trimmed and emptied of blanks. */
export function originsFromEnv(tenant: Pick<SeedTenant, 'originsVariable'>, source: Record<string, string | undefined> = process.env): string[] {
  return (source[tenant.originsVariable] ?? '')
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '');
}

export async function seedTenantOrigins(db: Db, tenantId: Id<'tnt'>, extra: readonly string[] = [], defaults: readonly string[] = SEED_TENANT_ORIGINS): Promise<SeedOriginsResult> {
  const before = new Set(await activeOrigins(db, tenantId));
  let created = 0;
  for (const origin of [...defaults, ...extra]) {
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
  locked: 'seed-locked-doubles',
  inProgress: 'seed-in-progress-doubles',
  awaiting: 'seed-awaiting-doubles',
  settled: 'seed-settled-doubles',
  cancelled: 'seed-cancelled-doubles',
  voided: 'seed-voided-doubles',
} as const;

export type SeedContestsResult = { contests: Array<{ externalId: string; id: string; state: string; created: boolean }> };

/**
 * One contest per state a contest can rest in (acceptance criterion 29; `settling` exists
 * only inside the settlement transaction): a `draft`, an `open` with four entered users
 * holding promo points, a `locked` one whose field is fixed, an `in_progress` one with
 * half its scores in, an `awaiting_settlement` one with every score in (the console's
 * close flow settles it behind the frozen preview), a `settled` one whose results
 * reconcile (I4, I5, I7), a `cancelled` one that never took an entry, and a `voided` one
 * whose entries were refunded. Each is keyed on its `external_id` and built in one
 * transaction through the same services the API uses, so a rerun creates nothing and a
 * partial run leaves nothing behind.
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
        case 'locked':
          return seedLockedContest(tx, tenantId, externalId);
        case 'inProgress':
          return seedInProgressContest(tx, tenantId, externalId);
        case 'awaiting':
          return seedAwaitingContest(tx, tenantId, externalId);
        case 'settled':
          return seedSettledContest(tx, tenantId, externalId);
        case 'cancelled':
          return seedCancelledContest(tx, tenantId, externalId);
        case 'voided':
          return seedVoidedContest(tx, tenantId, externalId);
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

/** Four entrants, the field fixed: no more entries, play has not started. */
async function seedLockedContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: Wednesday doubles (locked)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    maxParticipants: 8,
    prizeStructure: { type: 'winner_take_all' },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR, reason: 'seed' });
  const entrants = SEED_USER_IDS.slice(0, 4);
  await fundWallets(tx, tenantId, entrants);
  for (const userId of entrants) {
    await enterContest(tx, { tenantId, contestId: contest.id, userId, idempotencyKey: `seed:enter:${externalId}:${userId}`, actor: SEED_OPERATOR });
  }
  await transition(tx, { tenantId, contestId: contest.id, to: 'locked', actor: SEED_OPERATOR, reason: 'seed' });
  return getContest(tx, tenantId, contest.id);
}

/** Four entrants, play under way: two scores in, two attempts still open, so the contest cannot settle yet. */
async function seedInProgressContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: Thursday doubles (in progress)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    prizeStructure: { type: 'placement_table', placements: [{ placement: 1, amount: '250' }, { placement: 2, amount: '150' }] },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR, reason: 'seed' });
  const entrants = SEED_USER_IDS.slice(0, 4);
  await fundWallets(tx, tenantId, entrants);
  for (const userId of entrants) {
    await enterContest(tx, { tenantId, contestId: contest.id, userId, idempotencyKey: `seed:enter:${externalId}:${userId}`, actor: SEED_OPERATOR });
  }
  await transition(tx, { tenantId, contestId: contest.id, to: 'locked', actor: SEED_OPERATOR, reason: 'seed' });
  await transition(tx, { tenantId, contestId: contest.id, to: 'in_progress', actor: SEED_OPERATOR, reason: 'seed' });
  await submitScores(tx, {
    tenantId,
    contestId: contest.id,
    scores: entrants.slice(0, 2).map((userId, index) => ({ userId, score: [21, 16][index] ?? null, attemptFinished: true, sourceRef: `seed:match:${index + 1}` })),
    idempotencyKey: `seed:scores:${externalId}`,
    actor: SEED_OPERATOR,
  });
  return getContest(tx, tenantId, contest.id);
}

/** Four entrants, all scored (24, 21, 19, 17), results complete: waits for an operator to close it from the console. */
async function seedAwaitingContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: Friday night doubles (awaiting close)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    prizeStructure: { type: 'percentage_split', percentages: [60, 40] },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR, reason: 'seed' });
  const entrants = SEED_USER_IDS.slice(0, 4);
  await fundWallets(tx, tenantId, entrants);
  for (const userId of entrants) {
    await enterContest(tx, { tenantId, contestId: contest.id, userId, idempotencyKey: `seed:enter:${externalId}:${userId}`, actor: SEED_OPERATOR });
  }
  await transition(tx, { tenantId, contestId: contest.id, to: 'locked', actor: SEED_OPERATOR, reason: 'seed' });
  await transition(tx, { tenantId, contestId: contest.id, to: 'in_progress', actor: SEED_OPERATOR, reason: 'seed' });
  const scores = [24, 21, 19, 17];
  await submitScores(tx, {
    tenantId,
    contestId: contest.id,
    scores: entrants.map((userId, index) => ({ userId, score: scores[index] ?? null, attemptFinished: true, sourceRef: `seed:match:${index + 1}` })),
    idempotencyKey: `seed:scores:${externalId}`,
    actor: SEED_OPERATOR,
  });
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

/** Opened, then called off before anyone entered: `cancelled` is only reachable while no entry is held. */
async function seedCancelledContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: rained-out doubles (cancelled)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    prizeStructure: { type: 'winner_take_all' },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR, reason: 'seed' });
  await transition(tx, { tenantId, contestId: contest.id, to: 'cancelled', actor: SEED_OPERATOR, reason: 'seed: venue flooded' });
  return getContest(tx, tenantId, contest.id);
}

/** Three entrants, play started, then voided: every entry refunded by a reversing entry and the escrow back to zero. */
async function seedVoidedContest(tx: DbOrTx, tenantId: Id<'tnt'>, externalId: string): Promise<Contest> {
  const { contest } = await createContest(tx, {
    tenantId,
    externalId,
    kind: 'tournament',
    title: 'Sideout seed: heat-wave doubles (voided)',
    asset: 'POINTS',
    entryAmount: SEED_ENTRY_AMOUNT,
    prizeStructure: { type: 'percentage_split', percentages: [70, 30] },
    idempotencyKey: `seed:create:${externalId}`,
    actor: SEED_OPERATOR,
  });
  await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR, reason: 'seed' });
  const entrants = SEED_USER_IDS.slice(0, 3);
  await fundWallets(tx, tenantId, entrants);
  for (const userId of entrants) {
    await enterContest(tx, { tenantId, contestId: contest.id, userId, idempotencyKey: `seed:enter:${externalId}:${userId}`, actor: SEED_OPERATOR });
  }
  await transition(tx, { tenantId, contestId: contest.id, to: 'locked', actor: SEED_OPERATOR, reason: 'seed' });
  await transition(tx, { tenantId, contestId: contest.id, to: 'in_progress', actor: SEED_OPERATOR, reason: 'seed' });
  const voided = await voidContest(tx, { tenantId, contestId: contest.id, actor: SEED_OPERATOR, idempotencyKey: `seed:void:${externalId}`, reason: 'seed: play abandoned in a heat wave' });
  return voided.contest;
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

// ---- Operator console (phase 5) --------------------------------------------------------

/**
 * The first console account (spec 4.10): an `admin`, `PURSE_OPERATOR_ADMIN_EMAIL` or
 * `admin@purse.local`, with a random password that exists only in the return value of the
 * run that set it. `pnpm --filter @purse/api db:seed -- --print-operator-password` prints
 * it then and never again; `--rotate-operator-password` sets a new one and signs the
 * account out everywhere. A rerun without either flag leaves the account as it is.
 */
export const DEFAULT_OPERATOR_ADMIN_EMAIL = 'admin@purse.local';

export type SeedOperatorResult = { operator: Omit<Operator, 'passwordHash'>; password: string | null; created: boolean };

export async function seedOperatorAdmin(db: Db, options: { email?: string; rotate?: boolean } = {}): Promise<SeedOperatorResult> {
  const email = (options.email ?? DEFAULT_OPERATOR_ADMIN_EMAIL).trim().toLowerCase();
  const result = await db.transaction(async (tx): Promise<{ operator: Operator; password: string | null; created: boolean }> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seed-operator:${email}`}, 0))`);
    const [existing] = await tx.select().from(operators).where(eq(operators.email, email));
    if (existing !== undefined && options.rotate !== true) return { operator: existing, password: null, created: false };
    const password = generatePassword();
    if (existing !== undefined) {
      const rotated = await setPassword(tx, { operatorId: existing.id, newPassword: password, actor: SEED_OPERATOR });
      await revokeOtherSessions(tx, existing.id, null);
      return { operator: rotated, password, created: false };
    }
    const created = await createOperator(tx, { email, password, role: 'admin', actor: SEED_OPERATOR });
    return { operator: created, password, created: true };
  });
  const { passwordHash: _hash, ...operator } = result.operator;
  return { operator, password: result.password, created: result.created };
}

// ---- The second tenant (stretch item 4) ---------------------------------------------------

export type SeedSecondTenantResult = { tenant: Tenant; created: boolean; platform: PlatformAccountsResult; keys: SeedApiKeysResult; origins: SeedOriginsResult };

/**
 * Everything the ping-pong ladder needs on Purse and nothing more: its tenant row, the
 * platform accounts its promo points are issued from, its two sandbox keys and its
 * origins. Its users, contests and scores are the product's to make through the API; the
 * seed contests and users above are Sideout's. Runs after the Sideout seed in
 * `scripts/seed.ts` and `scripts/demo-reset.ts`, and is what the second consumer proved
 * a tenant costs: one row, six accounts, two keys and an allowlist.
 */
export async function seedSecondTenant(db: Db, options: { rotateKeys?: boolean; extraOrigins?: readonly string[] } = {}): Promise<SeedSecondTenantResult> {
  const { tenant, created } = await seedPingpongTenant(db);
  const tenantId = tenant.id as Id<'tnt'>;
  const platform = await seedPlatformAccounts(db, tenantId);
  const keys = await seedApiKeys(db, tenantId, { slug: PINGPONG_TENANT.slug, ...(options.rotateKeys === undefined ? {} : { rotate: options.rotateKeys }) });
  const origins = await seedTenantOrigins(db, tenantId, options.extraOrigins ?? [], PINGPONG_TENANT.devOrigins);
  return { tenant, created, platform, keys, origins };
}

// ---- Treasury (spec section 13) ------------------------------------------------------

/**
 * The stored instruments the demo's three verified players pay with. Deliberately one of
 * each family the rail accepts, so the treasury screens show a card, a charge card and a
 * bank debit side by side with their genuinely different processing costs.
 */
export const SEED_PAYMENT_METHODS = [
  { userIndex: 0, brand: 'visa' as const, last4: '4242', expMonth: 11, expYear: 2029, providerRef: 'tok_seed_visa_ana' },
  { userIndex: 1, brand: 'amex' as const, last4: '0005', expMonth: 4, expYear: 2028, providerRef: 'tok_seed_amex_marcus' },
  { userIndex: 2, brand: 'bank_account' as const, last4: '6789', providerRef: 'tok_seed_ach_priya' },
];

/** The demo's cash contest: a real-money bracket with a 5% rake, alongside the free-to-play ones. */
export const SEED_CASH_CONTEST = 'seed-cash-doubles';
export const SEED_CASH_ENTRY_USD_CENTS = 2_500n;
export const SEED_CASH_RAKE_BPS = 500;

export type SeedTreasuryResult = {
  methods: number;
  deposits: number;
  withdrawals: number;
  declined: number;
  cashContest: { externalId: string; id: string; state: string } | null;
};

/**
 * Money that actually moved, so every treasury screen is reading real rows.
 *
 * Deliberately not a tidy set. There is a declined charge, a withdrawal still in flight,
 * and a settled cash contest whose rake is in the platform fee account, because a demo in
 * which every payment succeeded proves nothing about the state machine. Every step runs
 * through the same services the API calls, so the seeded rows are indistinguishable from
 * rows a partner created, and the invariants are checked over them by CI immediately after.
 *
 * Idempotent on the payment's own idempotency key, like everything else here.
 */
export async function seedTreasury(db: Db, tenantId: Id<'tnt'>): Promise<SeedTreasuryResult> {
  const funding = devFundingProvider();
  const context = { tenantId, funding, actor: SEED_OPERATOR };
  const result: SeedTreasuryResult = { methods: 0, deposits: 0, withdrawals: 0, declined: 0, cashContest: null };

  const stored: Array<{ userId: Id<'usr'>; methodId: string }> = [];
  for (const spec of SEED_PAYMENT_METHODS) {
    const userId = SEED_USER_IDS[spec.userIndex];
    if (userId === undefined) continue;
    const existing = await listPaymentMethods(db, tenantId, userId);
    const already = existing.find((method) => method.providerRef === spec.providerRef);
    if (already !== undefined) {
      stored.push({ userId, methodId: already.id });
      continue;
    }
    const method = await addPaymentMethod(db, context, {
      userId,
      brand: spec.brand,
      last4: spec.last4,
      providerRef: spec.providerRef,
      ...(spec.expMonth === undefined ? {} : { expMonth: spec.expMonth }),
      ...(spec.expYear === undefined ? {} : { expYear: spec.expYear }),
    });
    stored.push({ userId, methodId: method.id });
    result.methods += 1;
  }

  // Three deposits of different sizes over three instrument families.
  const amounts = [20_000n, 7_500n, 5_000n];
  for (const [index, entry] of stored.entries()) {
    const amount = amounts[index] ?? 5_000n;
    const outcome = await deposit(db, context, {
      userId: entry.userId,
      amountUsdCents: amount,
      paymentMethodId: entry.methodId,
      idempotencyKey: `seed:deposit:${entry.userId}`,
      statementDescriptor: 'SIDEOUT COMPETITION',
    });
    if (outcome.payment.state === 'captured' || outcome.payment.state === 'settled') result.deposits += 1;
    // The first one is walked all the way to `settled`, so the demo has a completed one.
    if (index === 0 && outcome.payment.state === 'captured') {
      await confirmPayment(db, context, outcome.payment.id);
    }
  }

  // One charge the rail refuses, so the failure path is visible rather than described.
  const first = stored[0];
  if (first !== undefined) {
    const declined = await deposit(db, context, {
      userId: first.userId,
      amountUsdCents: 666n,
      paymentMethodId: first.methodId,
      idempotencyKey: `seed:deposit-declined:${first.userId}`,
      statementDescriptor: 'SIDEOUT COMPETITION',
    });
    if (declined.payment.state === 'failed') result.declined += 1;
  }

  // One withdrawal, left in `approved`: the claim is gone from the wallet and the cash is
  // still in flight, which is the state a treasury screen most needs to explain.
  const second = stored[1];
  if (second !== undefined) {
    const out = await requestWithdrawal(db, context, {
      userId: second.userId,
      amountUsdCents: 2_500n,
      paymentMethodId: second.methodId,
      idempotencyKey: `seed:withdrawal:${second.userId}`,
    });
    if (out.payment.state === 'approved' || out.payment.state === 'paid') result.withdrawals += 1;
  }

  result.cashContest = await seedCashContest(db, tenantId, stored.map((entry) => entry.userId));
  return result;
}

/**
 * A settled contest denominated in `CREDIT`, entered with money that was really deposited,
 * with the platform's rake taken off the top. This is the row that makes the fee account
 * non-zero, and the one the "follow a dollar" walkthrough reads.
 */
async function seedCashContest(db: Db, tenantId: Id<'tnt'>, players: ReadonlyArray<Id<'usr'>>): Promise<SeedTreasuryResult['cashContest']> {
  const [existing] = await db.select().from(contests).where(and(eq(contests.tenantId, tenantId), eq(contests.externalId, SEED_CASH_CONTEST)));
  if (existing !== undefined) return { externalId: SEED_CASH_CONTEST, id: existing.id, state: existing.state };
  if (players.length < 3) return null;

  return db.transaction(async (tx) => {
    const { contest } = await createContest(tx, {
      tenantId,
      externalId: SEED_CASH_CONTEST,
      kind: 'tournament',
      title: 'Sideout seed: Sunday cash doubles',
      asset: 'CREDIT',
      entryAmount: SEED_CASH_ENTRY_USD_CENTS,
      maxParticipants: 16,
      prizeStructure: { type: 'percentage_split', percentages: [60, 40] },
      rakeBps: SEED_CASH_RAKE_BPS,
      idempotencyKey: `seed:create:${SEED_CASH_CONTEST}`,
      actor: SEED_OPERATOR,
    });
    await transition(tx, { tenantId, contestId: contest.id, to: 'open', actor: SEED_OPERATOR });
    for (const [index, userId] of players.entries()) {
      await enterContest(tx, { tenantId, contestId: contest.id, userId, seed: index + 1, idempotencyKey: `seed:enter:${SEED_CASH_CONTEST}:${userId}`, actor: SEED_OPERATOR });
    }
    for (const step of ['locked', 'in_progress'] as const) {
      await transition(tx, { tenantId, contestId: contest.id, to: step, actor: SEED_OPERATOR });
    }
    await submitScores(tx, {
      tenantId,
      contestId: contest.id,
      scores: players.map((userId, index) => ({ userId, score: 30 - index * 7, attemptFinished: true })),
      idempotencyKey: `seed:scores:${SEED_CASH_CONTEST}`,
      actor: SEED_OPERATOR,
    });
    // Submitting every finished score already moves the contest to `awaiting_settlement`
    // (`contests/scores.ts`), so ask before pushing it there a second time.
    const scored = await getContest(tx, tenantId, contest.id);
    if (scored.state !== 'awaiting_settlement') {
      await transition(tx, { tenantId, contestId: contest.id, to: 'awaiting_settlement', actor: SEED_OPERATOR });
    }
    const preview = await previewSettlement(tx, { tenantId, contestId: contest.id });
    const closed = await closeContest(tx, {
      tenantId,
      contestId: contest.id,
      payoutHash: preview.payoutHash,
      actor: SEED_OPERATOR,
      idempotencyKey: `seed:close:${SEED_CASH_CONTEST}`,
    });
    return { externalId: SEED_CASH_CONTEST, id: closed.contest.id, state: closed.contest.state };
  });
}
