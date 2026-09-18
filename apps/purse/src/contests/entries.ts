import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { EligibilityDecision } from '@purse/types';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { contestParticipants, eligibilityDecisions, type Contest, type ContestParticipant, type EligibilityDecisionRow } from '../db/schema';
import { flagRiskReview, recordDecision, type RecordDecisionInput } from '../eligibility';
import { findAccount, openAccount } from '../ledger/accounts';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { balanceOf } from '../ledger/balance';
import { escrowEntry, refundEscrow } from '../ledger/flows';
import { getEntry, linesOf, type PostedEntry } from '../ledger/post';
import type { GeoProvider, RiskProvider } from '../providers/types';
import { getUser, resolveAndRecordLocation, type LocationInput } from '../users';
import { evaluateEntryEligibility, notEligible, rulesetVersionOf } from './eligibility';
import { ContestError } from './errors';
import { idempotent, ledgerKey } from './idempotency';
import { findParticipant, getContest, getParticipant, lockContest } from './load';

/**
 * Entering and withdrawing. Both hold the contest row lock for the whole transaction, so
 * two entries by one user, an entry racing a lock, or a withdrawal racing a close all
 * serialise and the loser sees the winner's state. The stake moves through the ledger's
 * typed flows in the same transaction as the participant row, keyed by the request's own
 * idempotency key, and `entry_journal_entry_id` records the escrow entry that holds it,
 * which is what invariant I7 checks. A withdrawn entrant may enter again while the contest
 * is open and before `locks_at`: the same row is reactivated with a fresh escrow entry and
 * the `team_ref` and `seed` of the new request, since a player who lost a partner comes
 * back with another (docs/decisions.md).
 *
 * Eligibility (spec 4.5) is decided under the contest lock and a per-user entry lock (so
 * two simultaneous entries by one user to different contests see each other's velocity),
 * with the wallet balance and the journal's rolling totals as they stand at that instant.
 * A `location` the request carries is resolved through the geo seam and recorded before
 * the entry's transaction opens, so it stands whatever the decision. Every attempt the
 * evaluator judges leaves one `eligibility_decisions` row: an allowed decision commits
 * with the entry; a refusal is written after the entry's transaction has rolled back, so
 * the record of the refusal and the location survive and nothing else does. A contest
 * that is not open or is full is refused before the evaluator runs, under the same
 * `not_eligible` shape (its reason and the version the contest is judged under) and with
 * no decision row.
 */
export type EnterContestInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  userId: string;
  /** The partner's opaque team reference, if any. */
  teamRef?: string | null;
  /** Seed for the `higher_seed_wins` tie-break; lower is better. */
  seed?: number | null;
  /** What the partner knows of where the user is now; resolved through the geo seam and recorded before the entry is attempted. */
  location?: LocationInput | null;
  /** The seams consulted at entry. Without them no location is resolved and no risk signals are gathered. */
  providers?: { geo?: GeoProvider; risk?: RiskProvider };
  idempotencyKey: string;
  actor?: Actor;
  requestId?: string;
  /** The clock `locks_at`, restrictions and velocity are checked against. Defaults to now. */
  now?: Date;
};

export type EnteredContest = {
  contest: Contest;
  participant: ContestParticipant;
  /** The escrow entry that took the stake. */
  entry: PostedEntry;
  eligibility: EligibilityDecision;
  /** The persisted decision (spec 4.5: the ruleset version is on every one). */
  decision: EligibilityDecisionRow;
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
  const requestId = input.requestId === undefined ? {} : { requestId: input.requestId };

  if (input.location !== undefined && input.location !== null) {
    const geo = input.providers?.geo;
    if (geo === undefined) throw new ContestError('invalid_input', 'a location was given but no geolocation provider is configured', { field: 'location' });
    const user = await getUser(db, input.tenantId, input.userId);
    await resolveAndRecordLocation(db, { user, location: input.location, geo, actor, now, ...requestId });
  }

  // A refusal is recorded after the transaction that would have escrowed the stake rolls back.
  let refusal: RecordDecisionInput | undefined;

  const attempt = db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Omit<EnteredContest, 'replayed'>, { contestId: string; participantId: string; entryId: string; decisionId: string }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.enter', request: { contestId: input.contestId, userId: input.userId, teamRef, seed } },
      {
        run: async () => {
          const user = await getUser(tx, input.tenantId, input.userId);
          const contest = await lockContest(tx, input.tenantId, input.contestId);
          if (contest.state !== 'open') {
            throw new ContestError('contest_not_open', `Contest ${contest.id} is ${contest.state}, not open for entries`, {
              contestId: contest.id,
              state: contest.state,
              reasons: ['contest_not_open'],
              rulesetVersion: await rulesetVersionOf(tx, contest),
            });
          }
          if (contest.locksAt !== null && contest.locksAt.getTime() <= now.getTime()) {
            throw new ContestError('contest_not_open', `Contest ${contest.id} locked at ${contest.locksAt.toISOString()}`, {
              contestId: contest.id,
              locksAt: contest.locksAt.toISOString(),
              reasons: ['contest_not_open'],
              rulesetVersion: await rulesetVersionOf(tx, contest),
            });
          }

          const existing = await findParticipant(tx, contest.id, input.userId);
          if (existing !== undefined && existing.state !== 'withdrawn') {
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
                rulesetVersion: await rulesetVersionOf(tx, contest),
              });
            }
          }

          // One entry decision per user at a time, whatever the contest, so the velocity one
          // reads includes the stake the other is about to take. Taken after the contest lock
          // in every path, so the two orders never cross.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user-entry:${user.id}`}, 0))`);

          // A wallet that does not exist holds nothing; open it so the decision can read a
          // balance and a refusal is `insufficient_balance`, not `account_not_found`. Rolled
          // back with the rest on failure.
          const { account: wallet } = await openAccount(tx, { tenantId: input.tenantId, kind: 'user_wallet', ownerRef: user.id, asset: contest.asset, actor, ...requestId });
          const walletBalance = await balanceOf(tx, wallet.id);

          const evaluated = await evaluateEntryEligibility(tx, {
            tenantId: input.tenantId,
            user,
            contest,
            walletBalance,
            now,
            ...(input.providers?.risk === undefined ? {} : { risk: input.providers.risk }),
          });
          const eligibility = evaluated.decision;
          const toRecord: RecordDecisionInput = { tenantId: input.tenantId, userId: user.id, contestId: contest.id, decision: eligibility, context: evaluated.context, ...requestId };
          if (!eligibility.allowed) {
            refusal = toRecord;
            throw notEligible(contest, user.id, eligibility, walletBalance);
          }
          const decision = await recordDecision(tx, toRecord);
          if (evaluated.risk !== null && input.providers?.risk !== undefined) {
            await flagRiskReview(tx, { tenantId: input.tenantId, userId: user.id, contestId: contest.id, risk: evaluated.risk, provider: input.providers.risk.name });
          }

          const entry = await escrowEntry(tx, {
            tenantId: input.tenantId,
            asset: contest.asset,
            walletAccountId: wallet.id,
            escrowAccountId: contest.escrowAccountId,
            amount: contest.entryAmount,
            contestId: contest.id as Id<'cnt'>,
            idempotencyKey: ledgerKey('contest-entry', input.idempotencyKey),
            description: `Entry of ${user.id} to contest ${contest.externalId}`,
          });

          const [participant] =
            existing === undefined
              ? await tx
                  .insert(contestParticipants)
                  .values({
                    id: newId('ent'),
                    contestId: contest.id,
                    userId: user.id,
                    teamRef,
                    seed,
                    entryJournalEntryId: entry.entry.id,
                  })
                  .returning()
              : await tx
                  .update(contestParticipants)
                  .set({ state: 'entered', entryJournalEntryId: entry.entry.id, teamRef, seed, updatedAt: sql`now()` })
                  .where(eq(contestParticipants.id, existing.id))
                  .returning();
          if (participant === undefined) throw new Error('contest_participants write returned no row');

          await recordAudit(tx, {
            tenantId: input.tenantId,
            actor,
            action: existing === undefined ? 'contest.entry.created' : 'contest.entry.reentered',
            subject: participant.id,
            before: existing ?? null,
            after: { ...participant, rulesetVersion: eligibility.rulesetVersion, decisionId: decision.id },
            ...requestId,
          });

          return {
            value: { contest, participant, entry, eligibility, decision },
            record: { contestId: contest.id, participantId: participant.id, entryId: entry.entry.id, decisionId: decision.id },
          };
        },
        replay: async (record) => {
          const decision = await loadDecision(tx, record.decisionId);
          return {
            contest: await getContest(tx, input.tenantId, record.contestId),
            participant: await getParticipant(tx, record.participantId),
            entry: await loadEntry(tx, record.entryId),
            eligibility: { allowed: true, rulesetVersion: decision.rulesetVersion },
            decision,
          };
        },
      },
    );
    return { ...value, replayed };
  });

  try {
    return await attempt;
  } catch (error) {
    if (refusal !== undefined) await recordDecision(db, refusal);
    throw error;
  }
}

async function loadDecision(db: DbOrTx, decisionId: string): Promise<EligibilityDecisionRow> {
  const [row] = await db.select().from(eligibilityDecisions).where(eq(eligibilityDecisions.id, decisionId));
  if (row === undefined) throw new Error(`Eligibility decision ${decisionId} recorded but not found`);
  return row;
}

export type WithdrawEntryInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  userId: string;
  idempotencyKey: string;
  actor?: Actor;
  requestId?: string;
  /** The clock `locks_at` is checked against. Defaults to now. */
  now?: Date;
};

export type WithdrawnEntry = {
  contest: Contest;
  participant: ContestParticipant;
  /** The `refund` entry that returned the stake. */
  refund: PostedEntry;
  replayed: boolean;
};

/**
 * Withdraw before lock (spec 4.2.5 "Refund a withdrawal before lock"): only while the
 * contest is `open` and, when it has a `locks_at`, before that instant, the same clock
 * `enterContest` reads. Once the lock time has passed the stake stays in escrow until
 * settlement or void, whether or not the operator has issued the `locked` transition yet.
 */
export async function withdrawEntry(db: DbOrTx, input: WithdrawEntryInput): Promise<WithdrawnEntry> {
  validateUserId(input.userId);
  const actor = input.actor ?? SYSTEM_ACTOR;
  const now = input.now ?? new Date();

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
          if (contest.locksAt !== null && contest.locksAt.getTime() <= now.getTime()) {
            throw new ContestError('invalid_contest_state', `Contest ${contest.id} locked at ${contest.locksAt.toISOString()}; entries can be withdrawn only before lock`, {
              contestId: contest.id,
              state: contest.state,
              locksAt: contest.locksAt.toISOString(),
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
