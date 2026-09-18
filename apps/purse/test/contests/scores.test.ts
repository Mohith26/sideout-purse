import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import { allExpectedResultsPresent, currentScores, enterContest, getContest, scoreHistory, submitScores, transition, withdrawEntry } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { auditLog, contestResults, contestScores } from '../../src/db/schema';
import { reconcile } from '../../src/ledger';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { advance, buildArena, contestError, escrowOf, inProgress, makeContest, OPERATOR, score, scoresFor, walletBalance, type Arena } from './fixtures';

/**
 * Spec 4.1 `contest_scores` (append-only, `superseded_by` chain), the "all expected results
 * present" rule that moves a contest to `awaiting_settlement`, and decision D6's two
 * settlement policies driven from the score path.
 */
describe('submitScores()', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 8 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 3 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const user = (i: number) => arena.users[i] ?? newId('usr');

  it('appends rows, supersedes an unfinished earlier score, and keeps the history', async () => {
    const contest = await inProgress(runtime.db, arena);
    const first = await score(runtime.db, arena, contest.id, [10, 20], { finished: false, users: [user(0), user(1)] });
    expect(first.replayed).toBe(false);
    expect(first.settlement).toBeNull();
    expect(first.contest.state).toBe('in_progress');
    expect(first.scores.map((row) => [row.userId, row.score, row.attemptFinished, row.supersededBy])).toEqual([
      [user(0), 10, false, null],
      [user(1), 20, false, null],
    ]);

    const second = await score(runtime.db, arena, contest.id, [12], { finished: false, users: [user(0)] });
    const current = await currentScores(runtime.db, contest.id);
    expect(current.map((row) => [row.userId, row.score])).toEqual([
      [user(0), 12],
      [user(1), 20],
    ]);
    const history = await scoreHistory(runtime.db, contest.id);
    expect(history).toHaveLength(3);
    expect(history.find((row) => row.id === first.scores[0]?.id)?.supersededBy).toBe(second.scores[0]?.id);
    expect(history.find((row) => row.id === second.scores[0]?.id)?.supersededBy).toBeNull();
  });

  it('refuses to overwrite a finished attempt, refusing the whole batch', async () => {
    const contest = await inProgress(runtime.db, arena);
    await score(runtime.db, arena, contest.id, [10], { finished: true, users: [user(0)] });
    const error = await contestError(score(runtime.db, arena, contest.id, [11, 5], { finished: false, users: [user(0), user(1)] }));
    expect(error.code).toBe('attempt_already_finished');
    expect(error.apiType).toBe('conflict');
    expect(error.detail).toMatchObject({ userId: user(0) });
    // Nothing from the batch landed: user(1) still has no score.
    expect((await currentScores(runtime.db, contest.id)).map((row) => row.userId)).toEqual([user(0)]);
    const [rows] = await runtime.db.select({ n: count() }).from(contestScores);
    expect(rows?.n).toBe(1);
  });

  it('is idempotent by key and validates its input', async () => {
    const contest = await inProgress(runtime.db, arena);
    const k = key('scores');
    const input = { tenantId: arena.tenantId, contestId: contest.id, scores: scoresFor([user(0)], [7], false), idempotencyKey: k };
    const first = await submitScores(runtime.db, input);
    const again = await submitScores(runtime.db, input);
    expect(again.replayed).toBe(true);
    expect(again.scores).toEqual(first.scores);
    expect(await scoreHistory(runtime.db, contest.id)).toHaveLength(1);
    const conflict = await contestError(submitScores(runtime.db, { ...input, scores: scoresFor([user(0)], [8], false) }));
    expect(conflict.code).toBe('idempotency_conflict');

    const cases: Array<[string, unknown]> = [
      ['duplicate_user', scoresFor([user(0), user(0)], [1, 2])],
      ['invalid_input', []],
      ['invalid_input', [{ userId: user(0), score: Number.NaN, attemptFinished: true }]],
      ['invalid_input', [{ userId: 'nope', score: 1, attemptFinished: true }]],
      ['invalid_input', [{ userId: user(0), score: 1, attemptFinished: 'yes' }]],
      ['not_a_participant', scoresFor([newId('usr')], [1])],
    ];
    for (const [code, scores] of cases) {
      const error = await contestError(submitScores(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, scores: scores as never, idempotencyKey: key() }));
      expect(error.code, JSON.stringify(scores)).toBe(code);
    }
  });

  it('is accepted in in_progress and awaiting_settlement only, and only for entered participants', async () => {
    const contest = await makeContest(runtime.db, arena);
    for (const state of ['open', 'locked'] as const) {
      await advance(runtime.db, arena, contest.id, state);
      if (state === 'open') {
        for (const userId of arena.users) await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId, idempotencyKey: key() });
        await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(2), idempotencyKey: key() });
      }
      const error = await contestError(score(runtime.db, arena, contest.id, [1], { users: [user(0)] }));
      expect(error.code).toBe('scores_not_accepted');
    }
    await advance(runtime.db, arena, contest.id, 'in_progress');
    const withdrawn = await contestError(score(runtime.db, arena, contest.id, [1], { users: [user(2)] }));
    expect(withdrawn.code).toBe('participant_not_active');
    expect(withdrawn.detail).toMatchObject({ participantState: 'withdrawn' });
    await score(runtime.db, arena, contest.id, [1], { users: [user(0)], finished: true });
    // The operator moves it on with user(1) unfinished; a late score is still accepted there.
    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'awaiting_settlement', actor: OPERATOR });
    const late = await score(runtime.db, arena, contest.id, [2], { users: [user(1)], finished: true });
    expect(late.contest.state).toBe('awaiting_settlement');
  });

  it('operator_close: the last expected result moves the contest to awaiting_settlement, then it waits for the close', async () => {
    const contest = await inProgress(runtime.db, arena, { settlementPolicy: 'operator_close' });
    expect(await allExpectedResultsPresent(runtime.db, contest.id)).toBe(false);
    await score(runtime.db, arena, contest.id, [10, 20], { finished: true, users: [user(0), user(1)] });
    expect(await allExpectedResultsPresent(runtime.db, contest.id)).toBe(false);
    expect((await getContest(runtime.db, arena.tenantId, contest.id)).state).toBe('in_progress');

    // An unfinished score for the last entrant does not count.
    await score(runtime.db, arena, contest.id, [5], { finished: false, users: [user(2)] });
    expect(await allExpectedResultsPresent(runtime.db, contest.id)).toBe(false);
    // A null score with attempt_finished (a no-show) does.
    const last = await score(runtime.db, arena, contest.id, [null], { finished: true, users: [user(2)] });
    expect(await allExpectedResultsPresent(runtime.db, contest.id)).toBe(true);
    expect(last.contest.state).toBe('awaiting_settlement');
    expect(last.settlement).toBeNull();
    expect(await escrowOf(runtime.db, contest)).toBe(300n);

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id)).orderBy(auditLog.createdAt, auditLog.id);
    const moved = audit.find((row) => row.action === 'contest.awaiting_settlement');
    expect(moved).toMatchObject({ actorKind: 'system' });
    expect(moved?.after).toMatchObject({ reason: 'all expected results present; last score submitted by tenant sideout' });
  });

  it('auto: the last expected result settles the contest in the same transaction, paying every winner', async () => {
    const contest = await inProgress(runtime.db, arena, { settlementPolicy: 'auto', prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] } });
    await score(runtime.db, arena, contest.id, [30, 20], { finished: true, users: [user(0), user(1)] });
    const lastKey = key('last');
    const last = await score(runtime.db, arena, contest.id, [10], { finished: true, users: [user(2)], key: lastKey });

    expect(last.contest.state).toBe('settled');
    expect(last.contest.settledAt).not.toBeNull();
    expect(last.settlement).not.toBeNull();
    expect(last.settlement?.payouts).toEqual([
      { userId: user(0), placement: 1, payout: 150n },
      { userId: user(1), placement: 2, payout: 90n },
      { userId: user(2), placement: 3, payout: 60n },
    ]);
    expect(last.settlement?.entry?.entry).toMatchObject({ kind: 'settle', contestId: contest.id, idempotencyKey: `contest:${contest.id}:settle` });
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(1050n);
    expect(await walletBalance(runtime.db, arena, user(1))).toBe(990n);
    expect(await walletBalance(runtime.db, arena, user(2))).toBe(960n);
    const results = await runtime.db.select().from(contestResults).where(eq(contestResults.contestId, contest.id));
    expect(results).toHaveLength(3);
    expect(results.every((row) => row.payoutJournalEntryId === last.settlement?.entry?.entry.id)).toBe(true);

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(audit.map((row) => row.action)).toEqual(['contest.created', 'contest.opened', 'contest.locked', 'contest.started', 'contest.awaiting_settlement', 'contest.settling', 'contest.settled']);
    expect(audit.slice(4).every((row) => row.actorKind === 'system')).toBe(true);

    // Replaying the batch that settled returns the settlement without settling again.
    const replay = await score(runtime.db, arena, contest.id, [10], { finished: true, users: [user(2)], key: lastKey });
    expect(replay.replayed).toBe(true);
    expect(replay.scores).toEqual(last.scores);
    expect(replay.settlement?.payouts).toEqual(last.settlement?.payouts);
    expect(replay.settlement?.payoutHash).toBe(last.settlement?.payoutHash);
    expect(replay.settlement?.entry?.entry.id).toBe(last.settlement?.entry?.entry.id);
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(1050n);
    expect((await reconcile(runtime.db)).ok).toBe(true);

    // No more scores once settled.
    const closed = await contestError(score(runtime.db, arena, contest.id, [99], { users: [user(0)] }));
    expect(closed.code).toBe('scores_not_accepted');
  });

  it('the database refuses to supersede a score twice, to un-supersede, to supersede a finished attempt, or to edit a score', async () => {
    const contest = await inProgress(runtime.db, arena);
    const a = (await score(runtime.db, arena, contest.id, [1], { finished: false, users: [user(0)] })).scores[0];
    const b = (await score(runtime.db, arena, contest.id, [2], { finished: false, users: [user(0)] })).scores[0];
    const c = (await score(runtime.db, arena, contest.id, [3], { finished: true, users: [user(0)] })).scores[0];
    const other = (await score(runtime.db, arena, contest.id, [9], { finished: false, users: [user(1)] })).scores[0];
    const ids = { a: a?.id ?? '', b: b?.id ?? '', c: c?.id ?? '', other: other?.id ?? '' };

    const twice = await rejection(migrator.sql`update contest_scores set superseded_by = ${ids.c} where id = ${ids.a}`);
    expect(String(twice)).toMatch(/was already superseded/);
    const undo = await rejection(migrator.sql`update contest_scores set superseded_by = null where id = ${ids.b}`);
    expect(String(undo)).toMatch(/cannot be un-superseded/);
    const finished = await rejection(migrator.sql`update contest_scores set superseded_by = ${ids.other} where id = ${ids.c}`);
    expect(String(finished)).toMatch(/finished attempt and cannot be superseded/);
    const wrongUser = await rejection(migrator.sql`update contest_scores set superseded_by = ${ids.c} where id = ${ids.other}`);
    expect(String(wrongUser)).toMatch(/same contest and user/);
    const edit = await rejection(migrator.sql`update contest_scores set score = 100 where id = ${ids.c}`);
    expect(String(edit)).toMatch(/append-only/);
    const runtimeEdit = await rejection(runtime.sql`update contest_scores set score = 100 where id = ${ids.c}`);
    expect(String(runtimeEdit)).toMatch(/permission denied for table contest_scores/);
    const runtimeDelete = await rejection(runtime.sql`delete from contest_scores where id = ${ids.a}`);
    expect(String(runtimeDelete)).toMatch(/permission denied for table contest_scores/);
    expect(await scoreHistory(runtime.db, contest.id)).toHaveLength(4);
  });
});
