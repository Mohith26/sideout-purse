import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { accounts, contestResults, type Contest, type ContestParticipant, type ContestResult, type ContestScore, type ParticipantState } from '../db/schema';
import { findRulesetForContest, flagCollusion } from '../eligibility';
import { openAccount } from '../ledger/accounts';
import type { Actor } from '../ledger/audit';
import { balanceOf } from '../ledger/balance';
import { settleEscrow, takeRake, voidEscrow } from '../ledger/flows';
import type { PostedEntry } from '../ledger/post';
import { PAYOUT_HASH_SHAPE, payoutHash, settle, type Payout, type SettleEntry } from '../settlement';
import { applyBps } from '../treasury/money';
import { loadEntry } from './entries';
import { ContestError } from './errors';
import { idempotent } from './idempotency';
import { activeParticipants, currentScores, getContest, listResults, lockContest } from './load';
import { assertTransition } from './states';
import { transition } from './transition';

/**
 * Preview, close and void (spec 4.7, 4.3). The preview and the close call the same pure
 * function on the same inputs; the preview returns `payoutHash`, the close requires it,
 * and a close whose recomputation hashes differently is refused. That single mechanism is
 * what makes "frozen preview" a guarantee.
 *
 * `closeContest` and the auto-settle path in `scores.ts` share `executeSettlement`, which
 * runs entirely under the contest row lock: `awaiting_settlement -> settling`, compute,
 * one `settle` entry crediting every winner, the `contest_results` rows, then
 * `settling -> settled`. A concurrent close waits on the lock and then finds the contest
 * settled; if anything fails, nothing (not even `settling`) was committed.
 */
export type PreviewEntry = SettleEntry & {
  participantId: string;
  participantState: ParticipantState;
  /** The counting score row, if any. */
  scoreId: string | null;
  attemptFinished: boolean;
};

export type SettlementPreview = {
  contest: Contest;
  /**
   * What the entrants put in: the escrow balance before the rake is taken. The preview
   * reports the gross so an operator sees the whole pot and where it goes, rather than a
   * net figure with a missing slice they have to work out.
   */
  escrowTotal: bigint;
  /** The platform's take, `rake_bps` of the gross, rounded down (spec 13.3). */
  rakeAmount: bigint;
  /** The gross less the rake: what the payouts actually divide. */
  netPool: bigint;
  entries: PreviewEntry[];
  payouts: Payout[];
  payoutHash: string;
};

/**
 * Compute what settling now would pay. No side effects; reads under one repeatable-read
 * snapshot so the escrow balance and the scores belong to the same instant. For a contest
 * that has settled, the preview is the settlement that was recorded, not a recomputation
 * over an escrow that is now empty.
 */
export async function previewSettlement(db: DbOrTx, input: { tenantId: Id<'tnt'>; contestId: string }): Promise<SettlementPreview> {
  return db.transaction(
    async (tx) => {
      const contest = await getContest(tx, input.tenantId, input.contestId);
      if (contest.state === 'settled') return recordedSettlement(tx, contest);
      return computeSettlement(tx, contest);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** The recorded results of a settled contest in the preview's shape: what was paid, and the hash a close presented. */
async function recordedSettlement(tx: DbOrTx, contest: Contest): Promise<SettlementPreview> {
  const settlement = await loadSettlement(tx, contest);
  const participants = await activeParticipants(tx, contest.id);
  const scores = await currentScores(tx, contest.id);
  const netPool = settlement.payouts.reduce((sum, payout) => sum + payout.payout, 0n);
  // The rake that was actually taken is in the journal, not recomputed from the current
  // `rake_bps`: a contest that settled under one rate must keep reporting that rate's fee
  // even if the column is later changed.
  const rakeAmount = await rakeTaken(tx, contest);
  return {
    contest,
    escrowTotal: netPool + rakeAmount,
    rakeAmount,
    netPool,
    entries: toEntries(participants, scores),
    payouts: settlement.payouts,
    payoutHash: settlement.payoutHash,
  };
}

/** The sum of the `fee` entries posted against this contest. Zero for a free-to-play one. */
export async function rakeTaken(db: DbOrTx, contest: Contest): Promise<bigint> {
  const [row] = await db.execute<{ total: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as total
    from journal_entries e
    join journal_lines l on l.entry_id = e.id
    join accounts a on a.id = l.account_id
    where e.contest_id = ${contest.id} and e.kind = 'fee' and a.kind = 'platform_fee' and l.direction = 'credit'
  `);
  return BigInt(row?.total ?? '0');
}

/** The one computation both the preview and the close run. Callers that will act on it hold the contest lock. */
export async function computeSettlement(tx: DbOrTx, contest: Contest): Promise<SettlementPreview> {
  const participants = await activeParticipants(tx, contest.id);
  const scores = await currentScores(tx, contest.id);
  const escrowTotal = await balanceOf(tx, contest.escrowAccountId);
  // The rake comes off the top, then the prize structure divides what is left. Rounding is
  // down (`applyBps`), so the remainder stays in the pool being divided and the rake can
  // never exceed the escrow it came from.
  const rakeAmount = applyBps(escrowTotal, contest.rakeBps);
  const netPool = escrowTotal - rakeAmount;
  const entries = toEntries(participants, scores);
  const payouts = settle({
    asset: contest.asset,
    escrowTotal: netPool,
    entries,
    prizeStructure: contest.prizeStructure,
    tieBreak: contest.tieBreak,
  });
  return { contest, escrowTotal, rakeAmount, netPool, entries, payouts, payoutHash: payoutHash(payouts) };
}

/**
 * Entrants as the engine sees them: everyone whose stake is in escrow. A disqualified
 * participant is unscored whatever was submitted for them, so they place last and take
 * nothing (docs/decisions.md).
 */
function toEntries(participants: readonly ContestParticipant[], scores: readonly ContestScore[]): PreviewEntry[] {
  const byUser = new Map(scores.map((score) => [score.userId, score]));
  return participants.map((participant) => {
    const score = participant.state === 'disqualified' ? undefined : byUser.get(participant.userId);
    return {
      userId: participant.userId,
      score: score?.score ?? null,
      seed: participant.seed,
      submittedAt: score?.submittedAt.toISOString() ?? null,
      participantId: participant.id,
      participantState: participant.state,
      scoreId: score?.id ?? null,
      attemptFinished: score?.attemptFinished ?? false,
    };
  });
}

export type SettlementOutcome = {
  contest: Contest;
  results: ContestResult[];
  payouts: Payout[];
  payoutHash: string;
  /** The `settle` entry, or `null` when nothing was owed (an empty pool). */
  entry: PostedEntry | null;
  /** The `fee` entry, or `null` when the contest takes no rake. */
  rake: PostedEntry | null;
};

export type ExecuteSettlementInput = {
  /** Already locked by the caller (`lockContest`); re-locked here, harmlessly, by the transitions. */
  contest: Contest;
  actor: Actor;
  /** The hash the caller previewed, or `null` for the auto-settle path, which has none to check. */
  expectedHash: string | null;
  requestId?: string;
};

export async function executeSettlement(tx: DbOrTx, input: ExecuteSettlementInput): Promise<SettlementOutcome> {
  const tenantId = input.contest.tenantId as Id<'tnt'>;
  const requestId = input.requestId === undefined ? {} : { requestId: input.requestId };

  const { after: settling } = await transition(tx, { tenantId, contestId: input.contest.id, to: 'settling', actor: input.actor, ...requestId });
  const preview = await computeSettlement(tx, settling);

  if (input.expectedHash !== null && input.expectedHash !== preview.payoutHash) {
    throw new ContestError('preview_hash_mismatch', `The payout preview is stale: the contest's inputs changed since it was computed. Fetch a new preview and close with its hash.`, {
      contestId: settling.id,
      presented: input.expectedHash,
      computed: preview.payoutHash,
    });
  }

  // The rake is its own entry, posted before the settlement and inside the same
  // transaction, so the settle entry only ever distributes the net pool. Doing it this way
  // rather than as an extra line on the settlement is what leaves I4 and I5 true without
  // amending either: I5 measures the escrow's non-`settle` movement, which this has
  // already reduced by the fee.
  let rake: PostedEntry | null = null;
  if (preview.rakeAmount > 0n) {
    const { account: feeAccount } = await openAccount(tx, {
      tenantId,
      kind: 'platform_fee',
      ownerRef: null,
      asset: settling.asset,
      actor: input.actor,
      ...requestId,
    });
    rake = await takeRake(tx, {
      tenantId,
      asset: settling.asset,
      escrowAccountId: settling.escrowAccountId,
      platformFeeAccountId: feeAccount.id,
      amount: preview.rakeAmount,
      contestId: settling.id as Id<'cnt'>,
      idempotencyKey: `contest:${settling.id}:rake`,
      description: `Platform fee of ${settling.rakeBps} bps on contest ${settling.externalId}`,
    });
  }

  const paid = preview.payouts.filter((payout) => payout.payout > 0n);
  let entry: PostedEntry | null = null;
  if (paid.length > 0) {
    const wallets = new Map<string, string>();
    for (const payout of paid) {
      const { account } = await openAccount(tx, { tenantId, kind: 'user_wallet', ownerRef: payout.userId, asset: settling.asset, actor: input.actor, ...requestId });
      wallets.set(payout.userId, account.id);
    }
    entry = await settleEscrow(tx, {
      tenantId,
      asset: settling.asset,
      escrowAccountId: settling.escrowAccountId,
      contestId: settling.id as Id<'cnt'>,
      idempotencyKey: `contest:${settling.id}:settle`,
      description: `Settlement of contest ${settling.externalId}`,
      payouts: paid.map((payout) => ({ walletAccountId: wallets.get(payout.userId) ?? '', amount: payout.payout })),
    });
  }

  const scoreOf = new Map(preview.entries.map((each) => [each.userId, each.score]));
  const results =
    preview.payouts.length === 0
      ? []
      : await tx
          .insert(contestResults)
          .values(
            preview.payouts.map((payout) => ({
              id: newId('res'),
              contestId: settling.id,
              userId: payout.userId,
              placement: payout.placement,
              score: scoreOf.get(payout.userId) ?? null,
              payoutAmount: payout.payout,
              payoutJournalEntryId: payout.payout > 0n && entry !== null ? entry.entry.id : null,
            })),
          )
          .returning();
  results.sort((a, b) => a.placement - b.placement || (a.userId < b.userId ? -1 : 1));

  const { after: settled } = await transition(tx, { tenantId, contestId: settling.id, to: 'settled', actor: input.actor, ...requestId });

  // The head-to-head collusion signal (spec 4.6) is checked the moment a meeting is
  // recorded, for the pair this settlement involved; surfaced as an operator flag, never
  // acted on.
  if (settled.kind === 'head_to_head' && results.length === 2) {
    const ruleset = await findRulesetForContest(tx, settled);
    if (ruleset !== undefined) await flagCollusion(tx, { tenantId, ruleset, users: results.map((row) => row.userId) });
  }
  return { contest: settled, results, payouts: preview.payouts, payoutHash: preview.payoutHash, entry, rake };
}

/** A settlement that already happened, rebuilt from its rows for a replay. */
export async function loadSettlement(tx: DbOrTx, contest: Contest): Promise<SettlementOutcome> {
  const results = await listResults(tx, contest.id);
  const payouts: Payout[] = results.map((row) => ({ userId: row.userId, placement: row.placement, payout: row.payoutAmount }));
  const entryId = results.find((row) => row.payoutJournalEntryId !== null)?.payoutJournalEntryId ?? null;
  const [feeEntry] = await tx.execute<{ id: string }>(sql`
    select id from journal_entries where contest_id = ${contest.id} and kind = 'fee' limit 1
  `);
  return {
    contest,
    results,
    payouts,
    payoutHash: payoutHash(payouts),
    entry: entryId === null ? null : await loadEntry(tx, entryId),
    rake: feeEntry === undefined ? null : await loadEntry(tx, feeEntry.id),
  };
}

export type CloseContestInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  /** From `previewSettlement`. */
  payoutHash: string;
  actor: Actor;
  idempotencyKey: string;
  requestId?: string;
};

export type ClosedContest = SettlementOutcome & { replayed: boolean };

/**
 * Operator close (spec 4.7 `POST /contests/:id/close`): settle `awaiting_settlement`
 * behind the previewed hash. Under `operator_close` the actor must be an operator; the
 * transition asserts it. A replay under the same key returns the original settlement; a
 * new request against a settled contest is refused as `already_settled`.
 */
export async function closeContest(db: DbOrTx, input: CloseContestInput): Promise<ClosedContest> {
  if (typeof input.payoutHash !== 'string' || !PAYOUT_HASH_SHAPE.test(input.payoutHash)) {
    throw new ContestError('invalid_payout_hash', 'payoutHash must be the 64-character hex digest returned by the preview', { field: 'payoutHash' });
  }
  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<SettlementOutcome, { contestId: string }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.close', request: { contestId: input.contestId, payoutHash: input.payoutHash } },
      {
        run: async () => {
          const contest = await lockContest(tx, input.tenantId, input.contestId);
          if (contest.state === 'settled') {
            throw new ContestError('already_settled', `Contest ${contest.id} was already settled at ${contest.settledAt?.toISOString() ?? 'unknown'}`, {
              contestId: contest.id,
              settledAt: contest.settledAt?.toISOString() ?? null,
            });
          }
          const outcome = await executeSettlement(tx, {
            contest,
            actor: input.actor,
            expectedHash: input.payoutHash,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          });
          return { value: outcome, record: { contestId: contest.id } };
        },
        replay: async (record) => loadSettlement(tx, await getContest(tx, input.tenantId, record.contestId)),
      },
    );
    return { ...value, replayed };
  });
}

export type VoidContestInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  actor: Actor;
  idempotencyKey: string;
  reason?: string;
  requestId?: string;
};

export type VoidedContest = {
  contest: Contest;
  /** One `void` entry (the reversal of the escrow entry) per non-withdrawn participant, in entry order. */
  refunds: PostedEntry[];
  replayed: boolean;
};

/**
 * Void (spec 4.7 `POST /contests/:id/void`, 4.2.5 "Void a contest"): refund every
 * non-withdrawn entry by reversing its escrow entry, then move to `voided`, whose guard
 * checks the escrow is empty. All under the contest row lock, in one transaction.
 *
 * The refunds are many posts, each locking one wallet and the escrow, so before the first
 * one every account they will touch is locked in id order in a single statement: the same
 * order `postEntry` uses and a settlement of another contest paying the same wallets uses,
 * so the two wait on each other instead of deadlocking. Each `voidEscrow` then only
 * re-locks rows this transaction already holds.
 */
export async function voidContest(db: DbOrTx, input: VoidContestInput): Promise<VoidedContest> {
  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Omit<VoidedContest, 'replayed'>, { contestId: string; refundEntryIds: string[] }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.void', request: { contestId: input.contestId } },
      {
        run: async () => {
          const contest = await lockContest(tx, input.tenantId, input.contestId);
          if (contest.state === 'voided') {
            throw new ContestError('already_voided', `Contest ${contest.id} was already voided`, { contestId: contest.id });
          }
          // Refuse before refunding anything: the same checks `transition` will make.
          assertTransition(contest, 'voided', input.actor);

          const participants = await activeParticipants(tx, contest.id);
          await lockRefundAccounts(tx, contest, participants);

          const refunds: PostedEntry[] = [];
          for (const participant of participants) {
            refunds.push(
              await voidEscrow(tx, {
                tenantId: input.tenantId,
                entryId: participant.entryJournalEntryId as Id<'je'>,
                idempotencyKey: `contest:${contest.id}:void:${participant.id}`,
                description: `Void of contest ${contest.externalId}: refund of ${participant.userId}`,
              }),
            );
          }

          const { after } = await transition(tx, {
            tenantId: input.tenantId,
            contestId: contest.id,
            to: 'voided',
            actor: input.actor,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          });
          return { value: { contest: after, refunds }, record: { contestId: after.id, refundEntryIds: refunds.map((refund) => refund.entry.id) } };
        },
        replay: async (record) => ({
          contest: await getContest(tx, input.tenantId, record.contestId),
          refunds: await Promise.all(record.refundEntryIds.map((id) => loadEntry(tx, id))),
        }),
      },
    );
    return { ...value, replayed };
  });
}

/** `SELECT ... FOR UPDATE`, sorted by id, on the escrow and every wallet the void's reversals will debit or credit. */
async function lockRefundAccounts(tx: DbOrTx, contest: Contest, participants: readonly ContestParticipant[]): Promise<void> {
  if (participants.length === 0) return;
  await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      or(
        eq(accounts.id, contest.escrowAccountId),
        and(
          eq(accounts.tenantId, contest.tenantId),
          eq(accounts.kind, 'user_wallet'),
          eq(accounts.asset, contest.asset),
          inArray(
            accounts.ownerRef,
            participants.map((participant) => participant.userId),
          ),
        ),
      ),
    )
    .orderBy(asc(accounts.id))
    .for('update');
}

/** The escrow balance of a contest, for callers that report it. */
export async function escrowBalance(db: DbOrTx, contest: Contest): Promise<bigint> {
  return balanceOf(db, contest.escrowAccountId);
}
