import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { contestParticipants, contestScores, type Contest, type ContestScore } from '../db/schema';
import { SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { ContestError } from './errors';
import { idempotent } from './idempotency';
import { getContest, lockContest, scoresById } from './load';
import { executeSettlement, loadSettlement, type SettlementOutcome } from './settlement';
import { transition } from './transition';

/**
 * Scores (spec 4.1 `contest_scores`, append-only). A batch is one mutation: every row in
 * it is accepted or none is. A new score for a user supersedes their previous one by
 * setting `superseded_by` on the old row, unless that row had `attempt_finished = true`,
 * in which case the whole batch is refused: a finished attempt is final (docs/decisions.md).
 *
 * After the rows are written, still under the contest row lock, the contest may advance:
 * when every expected result is present (every `entered` participant has a counting score
 * with `attempt_finished`), `in_progress` becomes `awaiting_settlement`, and a contest with
 * `settlement_policy = auto` settles right there in the same transaction. An
 * `operator_close` contest waits in `awaiting_settlement` for `closeContest`.
 *
 * Scores are accepted in `in_progress` and, as late corrections, in `awaiting_settlement`,
 * which is exactly the window the preview hash exists to guard.
 */
export type ScoreSubmission = {
  userId: string;
  /** A finite number, or `null` for an attempt with no score (a no-show): finished or not, it places last. */
  score: number | null;
  attemptFinished: boolean;
  sourceRef?: string | null;
};

export type SubmitScoresInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  scores: readonly ScoreSubmission[];
  idempotencyKey: string;
  actor?: Actor;
  requestId?: string;
};

export type SubmittedScores = {
  /** The contest after any advance the batch caused. */
  contest: Contest;
  /** The rows written, in submission order. */
  scores: ContestScore[];
  /** Present when this batch completed the results of an `auto` contest and settled it. */
  settlement: SettlementOutcome | null;
  replayed: boolean;
};

export const ACCEPTING_SCORES: ReadonlySet<Contest['state']> = new Set<Contest['state']>(['in_progress', 'awaiting_settlement']);
const BATCH_MAX = 1000;
const SOURCE_REF_MAX = 255;

export async function submitScores(db: DbOrTx, input: SubmitScoresInput): Promise<SubmittedScores> {
  const submissions = validateSubmissions(input.scores);
  const actor = input.actor ?? SYSTEM_ACTOR;
  const requestId = input.requestId === undefined ? {} : { requestId: input.requestId };

  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Omit<SubmittedScores, 'replayed'>, { contestId: string; scoreIds: string[]; settled: boolean }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.scores', request: { contestId: input.contestId, scores: submissions } },
      {
        run: async () => {
          const contest = await lockContest(tx, input.tenantId, input.contestId);
          if (!ACCEPTING_SCORES.has(contest.state)) {
            throw new ContestError('scores_not_accepted', `Contest ${contest.id} is ${contest.state}; scores are accepted while it is in progress or awaiting settlement`, {
              contestId: contest.id,
              state: contest.state,
              expected: [...ACCEPTING_SCORES],
            });
          }

          const userIds = submissions.map((each) => each.userId);
          const participants = await tx
            .select({ userId: contestParticipants.userId, state: contestParticipants.state })
            .from(contestParticipants)
            .where(and(eq(contestParticipants.contestId, contest.id), inArray(contestParticipants.userId, userIds)));
          const stateOf = new Map(participants.map((each) => [each.userId, each.state]));
          for (const userId of userIds) {
            const state = stateOf.get(userId);
            if (state === undefined) {
              throw new ContestError('not_a_participant', `User ${userId} has not entered contest ${contest.id}`, { contestId: contest.id, userId });
            }
            if (state !== 'entered') {
              throw new ContestError('participant_not_active', `User ${userId} is ${state} in contest ${contest.id} and cannot be scored`, {
                contestId: contest.id,
                userId,
                participantState: state,
              });
            }
          }

          const previous = await tx
            .select()
            .from(contestScores)
            .where(and(eq(contestScores.contestId, contest.id), inArray(contestScores.userId, userIds), isNull(contestScores.supersededBy)));
          const finished = previous.find((row) => row.attemptFinished);
          if (finished !== undefined) {
            throw new ContestError('attempt_already_finished', `User ${finished.userId} already has a finished attempt in contest ${contest.id}; it cannot be overwritten`, {
              contestId: contest.id,
              userId: finished.userId,
              scoreId: finished.id,
            });
          }

          const inserted = await tx
            .insert(contestScores)
            .values(
              submissions.map((each) => ({
                id: newId('sco'),
                contestId: contest.id,
                userId: each.userId,
                score: each.score,
                attemptFinished: each.attemptFinished,
                sourceRef: each.sourceRef,
                // The time the row is written, after the contest lock was taken, so for one
                // contest submission order is lock order: a batch that waited on the lock
                // must not carry a timestamp older than the score it supersedes.
                submittedAt: sql`clock_timestamp()`,
              })),
            )
            .returning();
          const byUser = new Map(inserted.map((row) => [row.userId, row]));
          const rows = submissions.map((each) => {
            const row = byUser.get(each.userId);
            if (row === undefined) throw new Error(`contest_scores insert returned no row for ${each.userId}`);
            return row;
          });
          for (const old of previous) {
            const successor = byUser.get(old.userId);
            if (successor === undefined) continue;
            await tx.update(contestScores).set({ supersededBy: successor.id }).where(eq(contestScores.id, old.id));
          }

          const advanced = await maybeAdvance(tx, contest, actor, requestId);
          return {
            value: { contest: advanced.contest, scores: rows, settlement: advanced.settlement },
            record: { contestId: contest.id, scoreIds: rows.map((row) => row.id), settled: advanced.settlement !== null },
          };
        },
        replay: async (record) => {
          const contest = await getContest(tx, input.tenantId, record.contestId);
          return {
            contest,
            scores: await scoresById(tx, record.scoreIds),
            settlement: record.settled ? await loadSettlement(tx, contest) : null,
          };
        },
      },
    );
    return { ...value, replayed };
  });
}

/**
 * "All expected results present" (docs/decisions.md): every participant in state
 * `entered` has a counting score whose `attempt_finished` is true. Withdrawn participants
 * hold no stake and disqualified ones are not expected to score. Vacuously true for a
 * contest with no entered participants, which only matters on a submission, and a
 * submission needs an entered participant.
 */
export async function allExpectedResultsPresent(db: DbOrTx, contestId: string): Promise<boolean> {
  const [row] = await db.execute<{ missing: string }>(sql`
    select count(*)::text as missing
    from contest_participants p
    where p.contest_id = ${contestId} and p.state = 'entered'
      and not exists (
        select 1 from contest_scores s
        where s.contest_id = p.contest_id and s.user_id = p.user_id and s.superseded_by is null and s.attempt_finished
      )
  `);
  return row?.missing === '0';
}

type Advanced = { contest: Contest; settlement: SettlementOutcome | null };

/**
 * After a batch, under the same lock: results complete moves `in_progress` on, and an
 * `auto` contest settles. The transition is the platform's (system actor); the settlement
 * of an `auto` contest is too, which `assertTransition` allows because the operator rule
 * binds only `operator_close`.
 */
async function maybeAdvance(tx: DbOrTx, contest: Contest, actor: Actor, requestId: { requestId?: string }): Promise<Advanced> {
  if (!(await allExpectedResultsPresent(tx, contest.id))) return { contest, settlement: null };
  let current = contest;
  if (current.state === 'in_progress') {
    current = (
      await transition(tx, {
        tenantId: current.tenantId as Id<'tnt'>,
        contestId: current.id,
        to: 'awaiting_settlement',
        actor: SYSTEM_ACTOR,
        reason: `all expected results present; last score submitted by ${actor.kind}${actor.ref === undefined ? '' : ` ${actor.ref}`}`,
        ...requestId,
      })
    ).after;
  }
  if (current.state === 'awaiting_settlement' && current.settlementPolicy === 'auto') {
    const settlement = await executeSettlement(tx, { contest: current, actor: SYSTEM_ACTOR, expectedHash: null, ...requestId });
    return { contest: settlement.contest, settlement };
  }
  return { contest: current, settlement: null };
}

function validateSubmissions(scores: readonly ScoreSubmission[]): Array<Required<ScoreSubmission>> {
  if (scores.length === 0 || scores.length > BATCH_MAX) {
    throw new ContestError('invalid_input', `scores must hold 1 to ${BATCH_MAX} submissions`, { field: 'scores', count: scores.length });
  }
  const seen = new Set<string>();
  return scores.map((each, index) => {
    if (!isId(each.userId, 'usr')) {
      throw new ContestError('invalid_input', `scores[${index}].userId must be a usr_ id`, { field: `scores.${index}.userId` });
    }
    if (seen.has(each.userId)) {
      throw new ContestError('duplicate_user', `scores[${index}]: ${each.userId} appears more than once in the batch`, { field: `scores.${index}.userId`, userId: each.userId });
    }
    seen.add(each.userId);
    if (each.score !== null && (typeof each.score !== 'number' || !Number.isFinite(each.score))) {
      throw new ContestError('invalid_input', `scores[${index}].score must be a finite number or null`, { field: `scores.${index}.score` });
    }
    if (typeof each.attemptFinished !== 'boolean') {
      throw new ContestError('invalid_input', `scores[${index}].attemptFinished must be a boolean`, { field: `scores.${index}.attemptFinished` });
    }
    const sourceRef = each.sourceRef ?? null;
    if (sourceRef !== null && (typeof sourceRef !== 'string' || sourceRef.trim().length === 0 || sourceRef.length > SOURCE_REF_MAX)) {
      throw new ContestError('invalid_input', `scores[${index}].sourceRef must be 1 to ${SOURCE_REF_MAX} characters when given`, { field: `scores.${index}.sourceRef` });
    }
    return { userId: each.userId, score: each.score, attemptFinished: each.attemptFinished, sourceRef };
  });
}
