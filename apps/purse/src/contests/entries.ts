import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { contestParticipants, type Contest, type ContestParticipant } from '../db/schema';
import { findAccount, openAccount } from '../ledger/accounts';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { escrowEntry, refundEscrow } from '../ledger/flows';
import { getEntry, linesOf, type PostedEntry } from '../ledger/post';
import { evaluateEntryEligibility, type EligibilityDecision } from './eligibility';
import { ContestError } from './errors';
import { idempotent, ledgerKey } from './idempotency';
import { findParticipant, getContest, getParticipant, lockContest } from './load';

/**
 * Entering and withdrawing. Both hold the contest row lock for the whole transaction, so
 * two entries by one user, an entry racing a lock, or a withdrawal racing a close all
 * serialise and the loser sees the winner's state. The stake moves through the ledger's
 * typed flows in the same transaction as the participant row, keyed by the request's own
 * idempotency key, and `entry_journal_entry_id` records the escrow entry that took it,
 * which is what invariant I7 checks.
 */
export type EnterContestInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  userId: string;
  /** The partner's opaque team reference, if any. */
  teamRef?: string | null;
  /** Seed for the `higher_seed_wins` tie-break; lower is better. */
  seed?: number | null;
  idempotencyKey: string;
  actor?: Actor;
  requestId?: string;
  /** The clock `locks_at` is checked against. Defaults to now. */
  now?: Date;
};

export type EnteredContest = {
  contest: Contest;
  participant: ContestParticipant;
  /** The escrow entry that took the stake. */
  entry: PostedEntry;
  eligibility: EligibilityDecision;
  replayed: boolean;
};

const TEAM_REF_MAX = 255;

export async function enterContest(db: DbOrTx, input: EnterContestInput): Promise<EnteredContest> {
  validateUserId(input.userId);
  const teamRef = input.teamRef ?? null;
  if (teamRef !== null && (typeof teamRef !== 'string' || teamRef.trim().length === 0 || teamRef.length > TEAM_REF_MAX)) {
    throw new ContestError('invalid_input', `teamRef must be 1 to ${TEAM_REF_MAX} characters when given`, { field: 'teamRef' });
  }
  const seed = input.seed ?? null;
  if (seed !== null && (!Number.isInteger(seed) || seed < 1)) {
    throw new ContestError('invalid_input', 'seed must be a positive integer when given', { field: 'seed' });
  }
  const actor = input.actor ?? SYSTEM_ACTOR;
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Omit<EnteredContest, 'replayed'>, { contestId: string; participantId: string; entryId: string; rulesetVersion: string }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.enter', request: { contestId: input.contestId, userId: input.userId, teamRef, seed } },
      {
        run: async () => {
          const contest = await lockContest(tx, input.tenantId, input.contestId);
          if (contest.state !== 'open') {
            throw new ContestError('contest_not_open', `Contest ${contest.id} is ${contest.state}, not open for entries`, {
              contestId: contest.id,
              state: contest.state,
              reasons: ['contest_not_open'],
            });
          }
          if (contest.locksAt !== null && contest.locksAt.getTime() <= now.getTime()) {
            throw new ContestError('contest_not_open', `Contest ${contest.id} locked at ${contest.locksAt.toISOString()}`, {
              contestId: contest.id,
              locksAt: contest.locksAt.toISOString(),
              reasons: ['contest_not_open'],
            });
          }

          const existing = await findParticipant(tx, contest.id, input.userId);
          if (existing !== undefined) {
            throw new ContestError('already_entered', `User ${input.userId} has already entered contest ${contest.id} (${existing.state})`, {
              contestId: contest.id,
              userId: input.userId,
              participantId: existing.id,
              participantState: existing.state,
            });
          }

          if (contest.maxParticipants !== null) {
            const [held] = await tx
              .select({ n: count() })
              .from(contestParticipants)
              .where(and(eq(contestParticipants.contestId, contest.id), inArray(contestParticipants.state, ['entered', 'disqualified'])));
            if ((held?.n ?? 0) >= contest.maxParticipants) {
              throw new ContestError('contest_full', `Contest ${contest.id} is full (${contest.maxParticipants})`, {
                contestId: contest.id,
                maxParticipants: contest.maxParticipants,
                reasons: ['contest_full'],
              });
            }
          }

          // Phase 3 replaces this hook with the eligibility engine; today it always allows.
          const eligibility = evaluateEntryEligibility({ userId: input.userId, contest });
          if (!eligibility.allowed) {
            throw new ContestError('not_eligible', `User ${input.userId} is not eligible to enter contest ${contest.id}`, {
              contestId: contest.id,
              userId: input.userId,
              reasons: eligibility.reasons,
              ...(eligibility.requiredAction === undefined ? {} : { requiredAction: eligibility.requiredAction }),
              rulesetVersion: eligibility.rulesetVersion,
            });
          }

          // A wallet that does not exist holds nothing; open it so the refusal is
          // `insufficient_funds`, not `account_not_found`. Rolled back with the rest on failure.
          const { account: wallet } = await openAccount(tx, {
            tenantId: input.tenantId,
            kind: 'user_wallet',
            ownerRef: input.userId,
            asset: contest.asset,
            actor,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          });

          const entry = await escrowEntry(tx, {
            tenantId: input.tenantId,
            asset: contest.asset,
            walletAccountId: wallet.id,
            escrowAccountId: contest.escrowAccountId,
            amount: contest.entryAmount,
            contestId: contest.id as Id<'cnt'>,
            idempotencyKey: ledgerKey('contest-entry', input.idempotencyKey),
            description: `Entry of ${input.userId} to contest ${contest.externalId}`,
          });

          const [participant] = await tx
            .insert(contestParticipants)
            .values({
              id: newId('ent'),
              contestId: contest.id,
              userId: input.userId,
              teamRef,
              seed,
              entryJournalEntryId: entry.entry.id,
            })
            .returning();
          if (participant === undefined) throw new Error('contest_participants insert returned no row');

          await recordAudit(tx, {
            tenantId: input.tenantId,
            actor,
            action: 'contest.entry.created',
            subject: participant.id,
            before: null,
            after: { ...participant, rulesetVersion: eligibility.rulesetVersion },
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          });

          return {
            value: { contest, participant, entry, eligibility },
            record: { contestId: contest.id, participantId: participant.id, entryId: entry.entry.id, rulesetVersion: eligibility.rulesetVersion },
          };
        },
        replay: async (record) => ({
          contest: await getContest(tx, input.tenantId, record.contestId),
          participant: await getParticipant(tx, record.participantId),
          entry: await loadEntry(tx, record.entryId),
          eligibility: { allowed: true, rulesetVersion: record.rulesetVersion },
        }),
      },
    );
    return { ...value, replayed };
  });
}

export type WithdrawEntryInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  userId: string;
  idempotencyKey: string;
  actor?: Actor;
  requestId?: string;
};

export type WithdrawnEntry = {
  contest: Contest;
  participant: ContestParticipant;
  /** The `refund` entry that returned the stake. */
  refund: PostedEntry;
  replayed: boolean;
};

/** Withdraw before lock (spec 4.2.5 "Refund a withdrawal before lock"): only while the contest is `open`. */
export async function withdrawEntry(db: DbOrTx, input: WithdrawEntryInput): Promise<WithdrawnEntry> {
  validateUserId(input.userId);
  const actor = input.actor ?? SYSTEM_ACTOR;

  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Omit<WithdrawnEntry, 'replayed'>, { contestId: string; participantId: string; refundEntryId: string }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.withdraw', request: { contestId: input.contestId, userId: input.userId } },
      {
        run: async () => {
          const contest = await lockContest(tx, input.tenantId, input.contestId);
          if (contest.state !== 'open') {
            throw new ContestError('invalid_contest_state', `Contest ${contest.id} is ${contest.state}; entries can be withdrawn only while it is open`, {
              contestId: contest.id,
              state: contest.state,
              expected: 'open',
            });
          }
          const before = await findParticipant(tx, contest.id, input.userId);
          if (before === undefined) {
            throw new ContestError('not_a_participant', `User ${input.userId} has not entered contest ${contest.id}`, { contestId: contest.id, userId: input.userId });
          }
          if (before.state !== 'entered') {
            throw new ContestError('participant_not_active', `User ${input.userId} is ${before.state} in contest ${contest.id}`, {
              contestId: contest.id,
              userId: input.userId,
              participantState: before.state,
            });
          }

          const wallet = await findAccount(tx, { tenantId: input.tenantId, kind: 'user_wallet', ownerRef: input.userId, asset: contest.asset });
          if (wallet === undefined) throw new Error(`Wallet of ${input.userId} in ${contest.asset} vanished after entry`);

          const refund = await refundEscrow(tx, {
            tenantId: input.tenantId,
            asset: contest.asset,
            escrowAccountId: contest.escrowAccountId,
            walletAccountId: wallet.id,
            amount: contest.entryAmount,
            contestId: contest.id as Id<'cnt'>,
            idempotencyKey: ledgerKey('contest-withdraw', input.idempotencyKey),
            description: `Withdrawal of ${input.userId} from contest ${contest.externalId}`,
          });

          const [after] = await tx
            .update(contestParticipants)
            .set({ state: 'withdrawn', updatedAt: sql`now()` })
            .where(eq(contestParticipants.id, before.id))
            .returning();
          if (after === undefined) throw new Error(`contest_participants update of ${before.id} returned no row`);

          await recordAudit(tx, {
            tenantId: input.tenantId,
            actor,
            action: 'contest.entry.withdrawn',
            subject: before.id,
            before,
            after: { ...after, refundEntryId: refund.entry.id },
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          });

          return { value: { contest, participant: after, refund }, record: { contestId: contest.id, participantId: after.id, refundEntryId: refund.entry.id } };
        },
        replay: async (record) => ({
          contest: await getContest(tx, input.tenantId, record.contestId),
          participant: await getParticipant(tx, record.participantId),
          refund: await loadEntry(tx, record.refundEntryId),
        }),
      },
    );
    return { ...value, replayed };
  });
}

function validateUserId(userId: string): void {
  if (!isId(userId, 'usr')) {
    throw new ContestError('invalid_input', 'userId must be a usr_ id', { field: 'userId' });
  }
}

/** An entry as `postEntry` returns it, reloaded for a replay. */
export async function loadEntry(db: DbOrTx, entryId: string): Promise<PostedEntry> {
  const entry = await getEntry(db, entryId);
  return { entry, lines: await linesOf(db, entry.id), replayed: true };
}
