import { newId, type Id } from '@repo/ids';

import {
  ContestError,
  createContest,
  enterContest,
  getContest,
  submitScores,
  transition,
  type CreateContestFields,
  type ScoreSubmission,
} from '../../src/contests';
import type { DbOrTx } from '../../src/db/client';
import type { Account, Asset, Contest } from '../../src/db/schema';
import { balanceOf, findAccount, issuePromoPoints, LedgerError, openAccount } from '../../src/ledger';
import type { Actor } from '../../src/ledger/audit';
import { createTenant, key, openPlatform } from '../ledger/fixtures';

/**
 * Contest test fixtures. Everything is built through the services under test; only the
 * tenant and its promo account are raw. `wipeLedger` (ledger fixtures) clears the contest
 * tables too.
 */
export const OPERATOR: Actor = { kind: 'operator', ref: 'op_test' };
export const TENANT_ACTOR: Actor = { kind: 'tenant', ref: 'sideout' };
export const USER_ACTOR: Actor = { kind: 'user', ref: 'usr_someone' };

export type Arena = {
  tenantId: Id<'tnt'>;
  asset: Asset;
  promo: Account;
  users: Array<Id<'usr'>>;
};

/** A tenant with a promo account and `users` funded wallets of `funding` each. */
export async function buildArena(db: DbOrTx, options: { users: number; funding?: bigint; asset?: Asset } = { users: 4 }): Promise<Arena> {
  const asset = options.asset ?? 'POINTS';
  const tenantId = await createTenant(db);
  const promo = await openPlatform(db, tenantId, 'promo_liability', asset);
  const users: Array<Id<'usr'>> = [];
  for (let i = 0; i < options.users; i += 1) {
    const userId = newId('usr');
    users.push(userId);
    if ((options.funding ?? 1000n) > 0n) await fund(db, { tenantId, asset, promo }, userId, options.funding ?? 1000n);
  }
  return { tenantId, asset, promo, users };
}

export async function fund(db: DbOrTx, arena: Pick<Arena, 'tenantId' | 'asset' | 'promo'>, userId: Id<'usr'>, amount: bigint): Promise<void> {
  const { account } = await openAccount(db, { tenantId: arena.tenantId, kind: 'user_wallet', ownerRef: userId, asset: arena.asset });
  await issuePromoPoints(db, {
    tenantId: arena.tenantId,
    asset: arena.asset,
    promoLiabilityAccountId: arena.promo.id,
    walletAccountId: account.id,
    amount,
    idempotencyKey: key('fund'),
  });
}

export const DEFAULT_FIELDS: CreateContestFields = {
  externalId: 'placeholder',
  kind: 'tournament',
  title: 'Test contest',
  asset: 'POINTS',
  entryAmount: 100n,
  prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] },
};

let externalCounter = 0;

export async function makeContest(db: DbOrTx, arena: Arena, overrides: Partial<CreateContestFields> = {}, actor: Actor = OPERATOR): Promise<Contest> {
  externalCounter += 1;
  const { contest } = await createContest(db, {
    tenantId: arena.tenantId,
    ...DEFAULT_FIELDS,
    asset: arena.asset,
    externalId: `ext-${process.pid}-${externalCounter}`,
    ...overrides,
    idempotencyKey: key('create'),
    actor,
  });
  return contest;
}

/** Drive a contest along the happy path from wherever it is to `to`, as the operator. */
export async function advance(db: DbOrTx, arena: Arena, contestId: string, to: 'open' | 'locked' | 'in_progress' | 'awaiting_settlement'): Promise<Contest> {
  const path: Array<Contest['state']> = ['draft', 'open', 'locked', 'in_progress', 'awaiting_settlement'];
  let current = await getContest(db, arena.tenantId, contestId);
  for (const step of path.slice(path.indexOf(current.state) + 1, path.indexOf(to) + 1)) {
    current = (await transition(db, { tenantId: arena.tenantId, contestId, to: step, actor: OPERATOR })).after;
  }
  return current;
}

export async function enterAll(db: DbOrTx, arena: Arena, contestId: string, users: Array<Id<'usr'>> = arena.users, seeds?: number[]): Promise<void> {
  for (const [index, userId] of users.entries()) {
    await enterContest(db, { tenantId: arena.tenantId, contestId, userId, seed: seeds?.[index] ?? null, idempotencyKey: key('enter'), actor: TENANT_ACTOR });
  }
}

/** A contest in `open` with every arena user entered (or the given ones). */
export async function openWithEntrants(db: DbOrTx, arena: Arena, overrides: Partial<CreateContestFields> = {}, users: Array<Id<'usr'>> = arena.users): Promise<Contest> {
  const contest = await makeContest(db, arena, overrides);
  await advance(db, arena, contest.id, 'open');
  await enterAll(db, arena, contest.id, users);
  return (await transition(db, { tenantId: arena.tenantId, contestId: contest.id, to: 'locked', actor: OPERATOR })).before;
}

/** A contest in `in_progress` with every arena user entered. */
export async function inProgress(db: DbOrTx, arena: Arena, overrides: Partial<CreateContestFields> = {}, users: Array<Id<'usr'>> = arena.users): Promise<Contest> {
  const contest = await makeContest(db, arena, overrides);
  await advance(db, arena, contest.id, 'open');
  await enterAll(db, arena, contest.id, users);
  return advance(db, arena, contest.id, 'in_progress');
}

export function scoresFor(users: Array<Id<'usr'>>, values: Array<number | null>, attemptFinished = true): ScoreSubmission[] {
  return users.map((userId, index) => ({ userId, score: values[index] ?? null, attemptFinished }));
}

export async function score(db: DbOrTx, arena: Arena, contestId: string, values: Array<number | null>, options: { finished?: boolean; users?: Array<Id<'usr'>>; key?: string } = {}) {
  return submitScores(db, {
    tenantId: arena.tenantId,
    contestId,
    scores: scoresFor(options.users ?? arena.users, values, options.finished ?? true),
    idempotencyKey: options.key ?? key('scores'),
    actor: TENANT_ACTOR,
  });
}

export async function walletBalance(db: DbOrTx, arena: Arena, userId: Id<'usr'>): Promise<bigint> {
  const wallet = await findAccount(db, { tenantId: arena.tenantId, kind: 'user_wallet', ownerRef: userId, asset: arena.asset });
  if (wallet === undefined) return 0n;
  return balanceOf(db, wallet.id);
}

export async function escrowOf(db: DbOrTx, contest: Contest): Promise<bigint> {
  return balanceOf(db, contest.escrowAccountId);
}

/** Await a promise expected to reject with a `ContestError`, returning it. */
export async function contestError(promise: Promise<unknown>): Promise<ContestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ContestError) return error;
    throw new Error(`Expected a ContestError, got ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the promise to reject with a ContestError');
}

export async function ledgerError(promise: Promise<unknown>): Promise<LedgerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw new Error(`Expected a LedgerError, got ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the promise to reject with a LedgerError');
}
