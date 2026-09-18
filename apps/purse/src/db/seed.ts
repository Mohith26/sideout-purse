import { and, eq } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import { closeContest, createContest, enterContest, getContest, previewSettlement, submitScores, transition } from '../contests';
import { findAccount, openAccount } from '../ledger/accounts';
import type { Actor } from '../ledger/audit';
import { issuePromoPoints } from '../ledger/flows';
import type { Db, DbOrTx } from './client';
import { asset, contests, tenants, type Account, type AccountKind, type Contest, type Tenant } from './schema';

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

// ---- Contests (phase 2) --------------------------------------------------------------

/**
 * Six users the seed contests are played by. Stable ids, like the tenant's, so every
 * environment agrees; phase 3 gives them `users` rows under the same ids. Their wallets
 * are funded with promo points through the ledger like anyone else's.
 */
export const SEED_USER_IDS: ReadonlyArray<Id<'usr'>> = [
  'usr_01a0b278-93be-70eb-9f0e-c4bfefda6f93',
  'usr_01a0b278-93be-70eb-9f0e-cbd06cb6e1b0',
  'usr_01a0b278-93be-70eb-9f0e-ce4de28b996c',
  'usr_01a0b278-93be-70eb-9f0e-d35624fd293e',
  'usr_01a0b278-93be-70eb-9f0e-d790d453c2f0',
  'usr_01a0b278-93be-70eb-9f0e-da1121d7a116',
];

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
