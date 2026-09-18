import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';
import type { ApiDataEnvelope, ApiErrorEnvelope } from '@purse/types';

import { closeContest, enterContest, getContest, listResults, previewSettlement, transition, voidContest, withdrawEntry } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { auditLog, contestResults, journalEntries } from '../../src/db/schema';
import { balanceOf, reconcile } from '../../src/ledger';
import type { PreviewResponse } from '../../src/routes/internal';
import { payoutHash } from '../../src/settlement';
import { connectMigrator, connectRuntime, harness, rejection } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { advance, buildArena, contestError, escrowOf, inProgress, makeContest, openWithEntrants, OPERATOR, score, TENANT_ACTOR, walletBalance, type Arena } from './fixtures';

/**
 * Spec 4.7 (preview and close computed by the same pure function, the hash the close
 * requires), 4.3 (`settling` under the row lock, `voided` with every entry refunded), 4.2.5
 * (the settle entry: one debit, many credits), and acceptance criteria 5 to 9.
 */
describe('previewSettlement() and closeContest()', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 8 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 4 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const user = (i: number) => arena.users[i] ?? newId('usr');

  it('closes behind the previewed hash: one settle entry, results written once, escrow zero, invariants clean', async () => {
    const contest = await inProgress(runtime.db, arena, { prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] } });
    // Scores with a tie for second and one unscored no-show (attempt finished, no score).
    await score(runtime.db, arena, contest.id, [21, 18, 18, null]);
    expect((await getContest(runtime.db, arena.tenantId, contest.id)).state).toBe('awaiting_settlement');

    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(preview.escrowTotal).toBe(400n);
    expect(preview.entries.map((e) => [e.userId, e.score, e.attemptFinished])).toEqual([
      [user(0), 21, true],
      [user(1), 18, true],
      [user(2), 18, true],
      [user(3), null, true],
    ]);
    // 50% of 400 = 200 to first; second and third tie and share 30% + 20% = 200 -> 100 each; the no-show places last with nothing.
    expect(preview.payouts).toEqual([
      { userId: user(0), placement: 1, payout: 200n },
      { userId: user(1), placement: 2, payout: 100n },
      { userId: user(2), placement: 2, payout: 100n },
      { userId: user(3), placement: 4, payout: 0n },
    ]);
    expect(preview.payoutHash).toBe(payoutHash(preview.payouts));
    // No side effects: the preview can be taken as often as wanted.
    expect(await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id })).toEqual(preview);
    expect((await getContest(runtime.db, arena.tenantId, contest.id)).state).toBe('awaiting_settlement');

    const k = key('close');
    const closed = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: k });
    expect(closed.replayed).toBe(false);
    expect(closed.contest.state).toBe('settled');
    expect(closed.contest.settledAt).toBeInstanceOf(Date);
    expect(closed.payouts).toEqual(preview.payouts);
    expect(closed.payoutHash).toBe(preview.payoutHash);

    // One entry, one debit of the escrow for the total, one credit per winner (spec 4.2.5).
    expect(closed.entry?.entry).toMatchObject({ kind: 'settle', contestId: contest.id });
    expect(closed.entry?.lines.map((l) => [l.direction, l.amount])).toEqual([
      ['debit', 400n],
      ['credit', 200n],
      ['credit', 100n],
      ['credit', 100n],
    ]);
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(1100n);
    expect(await walletBalance(runtime.db, arena, user(1))).toBe(1000n);
    expect(await walletBalance(runtime.db, arena, user(2))).toBe(1000n);
    expect(await walletBalance(runtime.db, arena, user(3))).toBe(900n);

    // Results, once: placement, score, payout, and the entry that paid it (null for a zero payout).
    expect(closed.results.map((r) => [r.userId, r.placement, r.score, r.payoutAmount, r.payoutJournalEntryId])).toEqual([
      [user(0), 1, 21, 200n, closed.entry?.entry.id],
      [user(1), 2, 18, 100n, closed.entry?.entry.id],
      [user(2), 2, 18, 100n, closed.entry?.entry.id],
      [user(3), 4, null, 0n, null],
    ]);
    expect(await listResults(runtime.db, contest.id)).toEqual(closed.results);

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(audit.slice(-2).map((row) => [row.action, row.actorKind, row.actorRef])).toEqual([
      ['contest.settling', 'operator', 'op_test'],
      ['contest.settled', 'operator', 'op_test'],
    ]);
    expect(audit.at(-1)?.before).toMatchObject({ state: 'settling', settledAt: null });
    expect(audit.at(-1)?.after).toMatchObject({ state: 'settled' });

    const report = await reconcile(runtime.db);
    expect(report.ok).toBe(true);
    expect(report.invariants.find((r) => r.id === 'I4')?.detail).toMatch(/every one of 1 settled or voided contests/);
    expect(report.invariants.find((r) => r.id === 'I5')?.detail).toMatch(/every one of 1 settled contests/);
    expect(report.invariants.find((r) => r.id === 'I7')?.detail).toMatch(/every one of 4 participants/);

    // A replay returns the original settlement; a new request finds it already settled.
    const again = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: k });
    expect(again.replayed).toBe(true);
    expect(again.results).toEqual(closed.results);
    expect(again.payouts).toEqual(closed.payouts);
    expect(again.payoutHash).toBe(closed.payoutHash);
    expect(again.entry?.entry.id).toBe(closed.entry?.entry.id);
    expect(again.contest).toEqual(closed.contest);
    const fresh = await contestError(closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() }));
    expect(fresh.code).toBe('already_settled');
    expect(fresh.apiType).toBe('invalid_state');
    // The preview of a settled contest is the settlement that was recorded, not a recomputation over an empty escrow.
    const after = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(after.payouts).toEqual(preview.payouts);
    expect(after.payoutHash).toBe(preview.payoutHash);
    expect(after.escrowTotal).toBe(400n);
    expect(after.contest.state).toBe('settled');
    const [entries] = await runtime.db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.kind, 'settle'));
    expect(entries?.n).toBe(1);
    const [results] = await runtime.db.select({ n: count() }).from(contestResults);
    expect(results?.n).toBe(4);
  });

  it('rejects a stale hash: a late score after the preview changes the payouts and the close is refused, moving nothing', async () => {
    const contest = await inProgress(runtime.db, arena);
    await score(runtime.db, arena, contest.id, [10, 9, 8], { users: [user(0), user(1), user(2)] });
    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'awaiting_settlement', actor: OPERATOR, reason: 'user 4 is a no-show' });
    const stale = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(stale.payouts.find((p) => p.userId === user(3))).toMatchObject({ placement: 4, payout: 0n });

    // The late score arrives, and user 4 now wins.
    await score(runtime.db, arena, contest.id, [99], { users: [user(3)] });
    const error = await contestError(closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: stale.payoutHash, actor: OPERATOR, idempotencyKey: key() }));
    expect(error.code).toBe('preview_hash_mismatch');
    expect(error.apiType).toBe('conflict');
    expect(error.detail).toMatchObject({ presented: stale.payoutHash });
    expect(error.detail['computed']).not.toBe(stale.payoutHash);

    // Nothing happened: not even `settling` was committed.
    const current = await getContest(runtime.db, arena.tenantId, contest.id);
    expect(current.state).toBe('awaiting_settlement');
    expect(await escrowOf(runtime.db, contest)).toBe(400n);
    expect(await listResults(runtime.db, contest.id)).toEqual([]);
    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id));
    expect(audit.some((row) => row.action === 'contest.settling')).toBe(false);

    // A fresh preview closes.
    const fresh = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(fresh.payouts[0]).toMatchObject({ userId: user(3), placement: 1, payout: 200n });
    const closed = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: fresh.payoutHash, actor: OPERATOR, idempotencyKey: key() });
    expect(closed.contest.state).toBe('settled');
    expect(await walletBalance(runtime.db, arena, user(3))).toBe(1100n);
  });

  it('operator_close: a tenant or the system cannot close; auto: they can', async () => {
    const contest = await inProgress(runtime.db, arena, { settlementPolicy: 'operator_close' });
    await score(runtime.db, arena, contest.id, [4, 3, 2, 1]);
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    for (const actor of [TENANT_ACTOR, { kind: 'system' as const }]) {
      const error = await contestError(closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor, idempotencyKey: key() }));
      expect(error.code).toBe('operator_required');
      expect(error.apiType).toBe('permission_error');
    }
    expect((await getContest(runtime.db, arena.tenantId, contest.id)).state).toBe('awaiting_settlement');

    const auto = await inProgress(runtime.db, arena, { settlementPolicy: 'auto' });
    await score(runtime.db, arena, auto.id, [1, 2, 3], { users: [user(0), user(1), user(2)] });
    await transition(runtime.db, { tenantId: arena.tenantId, contestId: auto.id, to: 'awaiting_settlement', actor: OPERATOR });
    const autoPreview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: auto.id });
    const closed = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: auto.id, payoutHash: autoPreview.payoutHash, actor: TENANT_ACTOR, idempotencyKey: key() });
    expect(closed.contest.state).toBe('settled');
  });

  it('refuses a close from any state but awaiting_settlement, a malformed hash, and another tenant', async () => {
    const contest = await inProgress(runtime.db, arena);
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    const early = await contestError(closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() }));
    expect(early.code).toBe('invalid_transition');
    expect(early.detail).toMatchObject({ from: 'in_progress', to: 'settling' });
    const malformed = await contestError(closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: 'abc', actor: OPERATOR, idempotencyKey: key() }));
    expect(malformed.code).toBe('invalid_payout_hash');
    const other = await buildArena(runtime.db, { users: 0 });
    const foreign = await contestError(closeContest(runtime.db, { tenantId: other.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() }));
    expect(foreign.code).toBe('contest_wrong_tenant');
    const foreignPreview = await contestError(previewSettlement(runtime.db, { tenantId: other.tenantId, contestId: contest.id }));
    expect(foreignPreview.code).toBe('contest_wrong_tenant');
  });

  it('a contest with no one left in it settles to nothing: no entry, no results, escrow zero', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(preview).toMatchObject({ escrowTotal: 0n, entries: [], payouts: [] });
    const closed = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() });
    expect(closed).toMatchObject({ contest: { state: 'settled' }, results: [], payouts: [], entry: null, replayed: false });
    expect((await reconcile(runtime.db)).ok).toBe(true);
    const replay = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() }).catch((error: unknown) => error);
    expect(replay).toMatchObject({ code: 'already_settled' });
  });

  it('a single entrant in a winner_take_all gets their own entry back', async () => {
    const contest = await makeContest(runtime.db, arena, { prizeStructure: { type: 'winner_take_all' } });
    await advance(runtime.db, arena, contest.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key() });
    await advance(runtime.db, arena, contest.id, 'in_progress');
    const done = await score(runtime.db, arena, contest.id, [7], { users: [user(0)] });
    expect(done.contest.state).toBe('awaiting_settlement');
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(preview.payouts).toEqual([{ userId: user(0), placement: 1, payout: 100n }]);
    await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() });
    expect(await walletBalance(runtime.db, arena, user(0))).toBe(1000n);
  });

  it('contest_results are append-only for the runtime and reject a payout without an entry', async () => {
    const contest = await inProgress(runtime.db, arena);
    await score(runtime.db, arena, contest.id, [4, 3, 2, 1]);
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    const closed = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() });
    const first = closed.results[0];
    const update = await rejection(runtime.sql`update contest_results set payout_amount = 1 where id = ${first?.id ?? ''}`);
    expect(String(update)).toMatch(/permission denied for table contest_results/);
    const del = await rejection(runtime.sql`delete from contest_results where id = ${first?.id ?? ''}`);
    expect(String(del)).toMatch(/permission denied for table contest_results/);
    const orphan = await rejection(
      migrator.db.insert(contestResults).values({ id: newId('res'), contestId: contest.id, userId: newId('usr'), placement: 9, payoutAmount: 5n, payoutJournalEntryId: null }),
    );
    expect(String((orphan as Error).cause)).toMatch(/contest_results_zero_payout_has_no_entry/);
  });
});

describe('voidContest() and cancelling', () => {
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

  it('refunds every non-withdrawn entry by reversing its escrow entry and lands on voided with escrow zero', async () => {
    const contest = await openWithEntrants(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'in_progress');
    const k = key('void');
    const voided = await voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: k, reason: 'rained out' });
    expect(voided.replayed).toBe(false);
    expect(voided.contest.state).toBe('voided');
    expect(voided.refunds).toHaveLength(3);
    for (const refund of voided.refunds) {
      expect(refund.entry.kind).toBe('void');
      expect(refund.entry.reversesEntryId).not.toBeNull();
      expect(refund.entry.contestId).toBe(contest.id);
    }
    const reversed = new Set(voided.refunds.map((refund) => refund.entry.reversesEntryId));
    const participants = await runtime.db.query.contestParticipants.findMany({ where: (table, { eq: equal }) => equal(table.contestId, contest.id) });
    expect(participants.map((p) => p.entryJournalEntryId).every((id) => reversed.has(id))).toBe(true);
    expect(participants.every((p) => p.state === 'entered')).toBe(true);
    expect(await escrowOf(runtime.db, contest)).toBe(0n);
    for (const u of arena.users) expect(await walletBalance(runtime.db, arena, u)).toBe(1000n);
    expect((await reconcile(runtime.db)).ok).toBe(true);

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(audit.at(-1)).toMatchObject({ action: 'contest.voided', actorKind: 'operator' });
    expect(audit.at(-1)?.after).toMatchObject({ state: 'voided', reason: 'rained out' });

    const again = await voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: k, reason: 'rained out' });
    expect(again.replayed).toBe(true);
    expect(again.refunds.map((r) => r.entry.id)).toEqual(voided.refunds.map((r) => r.entry.id));
    expect(again.contest).toEqual(voided.contest);
    const fresh = await contestError(voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: key() }));
    expect(fresh.code).toBe('already_voided');
    const [voids] = await runtime.db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.kind, 'void'));
    expect(voids?.n).toBe(3);
  });

  it('skips withdrawn entrants (already refunded) and works from open, locked, in_progress and awaiting_settlement', async () => {
    for (const state of ['open', 'locked', 'in_progress', 'awaiting_settlement'] as const) {
      const contest = await makeContest(runtime.db, arena);
      await advance(runtime.db, arena, contest.id, 'open');
        for (const u of arena.users) await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: u, idempotencyKey: key() });
      await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(2), idempotencyKey: key() });
      if (state !== 'open') await advance(runtime.db, arena, contest.id, state);
      const voided = await voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: OPERATOR, idempotencyKey: key() });
      expect(voided.refunds, state).toHaveLength(2);
      expect(await escrowOf(runtime.db, contest)).toBe(0n);
    }
    for (const u of arena.users) expect(await walletBalance(runtime.db, arena, u)).toBe(1000n);
    expect((await reconcile(runtime.db)).ok).toBe(true);
  });

  it('honours the operator rule from awaiting_settlement and refuses terminal states, refunding nothing on refusal', async () => {
    const contest = await openWithEntrants(runtime.db, arena, { settlementPolicy: 'operator_close' });
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    const refused = await contestError(voidContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, actor: TENANT_ACTOR, idempotencyKey: key() }));
    expect(refused.code).toBe('operator_required');
    expect(await escrowOf(runtime.db, contest)).toBe(300n);
    const [voids] = await runtime.db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.kind, 'void'));
    expect(voids?.n).toBe(0);

    const draft = await makeContest(runtime.db, arena);
    const fromDraft = await contestError(voidContest(runtime.db, { tenantId: arena.tenantId, contestId: draft.id, actor: OPERATOR, idempotencyKey: key() }));
    expect(fromDraft.code).toBe('invalid_transition');
  });

  it('an empty contest is cancelled, not voided; one with entries is voided, not cancelled', async () => {
    const empty = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, empty.id, 'open');
    const cancelled = await transition(runtime.db, { tenantId: arena.tenantId, contestId: empty.id, to: 'cancelled', actor: OPERATOR });
    expect(cancelled.after.state).toBe('cancelled');
    expect(await balanceOf(runtime.db, empty.escrowAccountId)).toBe(0n);

    const full = await openWithEntrants(runtime.db, arena);
    const refused = await contestError(transition(runtime.db, { tenantId: arena.tenantId, contestId: full.id, to: 'cancelled', actor: OPERATOR }));
    expect(refused.code).toBe('contest_has_entries');
  });
});

describe('GET /internal/contests/:id/preview', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
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

  it('returns the preview with amounts as strings and the hash a close accepts', async () => {
    const contest = await inProgress(runtime.db, arena);
    await score(runtime.db, arena, contest.id, [3, 2, 1]);
    const h = harness();
    try {
      const res = await h.app.request(`/internal/contests/${contest.id}/preview`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiDataEnvelope<PreviewResponse>;
      expect(body.data.contest).toMatchObject({ id: contest.id, state: 'awaiting_settlement', asset: 'POINTS', settlementPolicy: 'operator_close' });
      expect(body.data.escrowTotal).toBe('300');
      expect(body.data.payouts).toEqual([
        { userId: arena.users[0], placement: 1, payout: '150' },
        { userId: arena.users[1], placement: 2, payout: '90' },
        { userId: arena.users[2], placement: 3, payout: '60' },
      ]);
      expect(body.data.entries).toHaveLength(3);
      expect(body.data.payoutHash).toMatch(/^[0-9a-f]{64}$/);
      // Money is never a JSON number.
      expect(body.data.payouts.every((p) => typeof p.payout === 'string')).toBe(true);
      expect(typeof body.data.escrowTotal).toBe('string');

      const closed = await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: body.data.payoutHash, actor: OPERATOR, idempotencyKey: key() });
      expect(closed.contest.state).toBe('settled');
      expect(h.lines.some((l) => l['msg'] === 'settlement preview' && l['contestId'] === contest.id)).toBe(true);

      const missing = await h.app.request(`/internal/contests/${newId('cnt')}/preview`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as ApiErrorEnvelope).error).toMatchObject({ type: 'invalid_request', code: 'contest_not_found' });
    } finally {
      await h.close();
    }
  });

  it('is behind the same bearer token as reconcile', async () => {
    const contest = await makeContest(runtime.db, arena);
    const token = 'internal-token-for-tests-0123456789';
    const h = harness({ internalApiToken: token });
    try {
      expect((await h.app.request(`/internal/contests/${contest.id}/preview`)).status).toBe(401);
      expect((await h.app.request(`/internal/contests/${contest.id}/preview`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
