import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ConsoleSettlementResource, ContestDetailResource, ContestSummaryResource, PreviewResource, VoidResource } from '@purse/types';

import { auditLog } from '../../src/db/schema';
import { balanceOf } from '../../src/ledger';
import { advance, buildArena, inProgress, makeContest, openWithEntrants, score } from '../contests/fixtures';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { consoleClient } from './client';

/**
 * The contest browser and the close flow (spec 4.10, 4.7): contests across tenants by
 * state, one contest with its escrow balance, entrants, scores and results; the two-step
 * commit: the preview's hash is what `close` must present, a stale hash is refused as
 * `conflict`, a settled contest is refused as `invalid_state`, and the operator actor is
 * what lets an `operator_close` contest settle. Transitions and void are here too.
 */
describe('console contests and the close flow', () => {
  let h: TestHarness;
  let owner: ReturnType<typeof connectMigrator>;

  beforeAll(() => {
    owner = connectMigrator();
    h = harness();
  });
  beforeEach(async () => {
    await wipeLedger(owner);
  });
  afterAll(async () => {
    await wipeLedger(owner);
    await h.close();
    await owner.close();
  });

  it('browses contests across every tenant by state, with the escrow balance and entrant count derived', async () => {
    const a = await buildArena(h.database.db, { users: 3 });
    const b = await buildArena(h.database.db, { users: 2 });
    const draft = await makeContest(h.database.db, a);
    // `openWithEntrants` enters everyone and then locks the contest.
    const open = await openWithEntrants(h.database.db, a, { entryAmount: 50n });
    const inB = await openWithEntrants(h.database.db, b, { entryAmount: 10n });
    const { api } = await consoleClient(h, owner.db, 'operator');

    const all = await api.get<{ contests: ContestSummaryResource[] }>('/console/contests');
    expect(all.status).toBe(200);
    expect(all.data?.contests.map((each) => each.id).sort()).toEqual([draft.id, open.id, inB.id].sort());
    const openRow = all.data?.contests.find((each) => each.id === open.id);
    expect(openRow).toMatchObject({ state: 'locked', escrowBalance: '150', participantCount: 3, tenantId: a.tenantId });
    expect(openRow?.tenantName).toMatch(/^tenant-/);

    const locked = await api.get<{ contests: ContestSummaryResource[] }>('/console/contests?state=locked');
    expect(locked.data?.contests.map((each) => each.id).sort()).toEqual([open.id, inB.id].sort());
    expect((await api.get<{ contests: ContestSummaryResource[] }>('/console/contests?state=draft')).data?.contests.map((each) => each.id)).toEqual([draft.id]);
    const ofB = await api.get<{ contests: ContestSummaryResource[] }>(`/console/contests?tenantId=${b.tenantId}`);
    expect(ofB.data?.contests.map((each) => each.id)).toEqual([inB.id]);
    expect((await api.get('/console/contests?state=nope')).status).toBe(400);
  });

  it('shows one contest with entrants, scores and results, and refuses another tenant’s', async () => {
    const arena = await buildArena(h.database.db, { users: 3 });
    const contest = await inProgress(h.database.db, arena, { entryAmount: 100n });
    await score(h.database.db, arena, contest.id, [10, 20, null], { finished: false });
    const { api } = await consoleClient(h, owner.db, 'operator');
    const detail = await api.get<ContestDetailResource>(`/console/tenants/${arena.tenantId}/contests/${contest.id}`);
    expect(detail.status).toBe(200);
    expect(detail.data?.contest).toMatchObject({ id: contest.id, state: 'in_progress', escrowBalance: '300', participantCount: 3 });
    expect(detail.data?.participants).toHaveLength(3);
    expect(detail.data?.participants[0]?.state).toBe('entered');
    expect(detail.data?.participants[0]?.externalId).toMatch(/./);
    expect(detail.data?.participants.every((each) => each.entryJournalEntryId.startsWith('je_'))).toBe(true);
    expect(detail.data?.scores.map((each) => each.score).sort()).toEqual([10, 20, null].sort());
    expect(detail.data?.results).toEqual([]);

    const other = await buildArena(h.database.db, { users: 0 });
    const wrong = await api.get(`/console/tenants/${other.tenantId}/contests/${contest.id}`);
    expect(wrong.status).toBe(403);
    expect(wrong.error?.code).toBe('contest_wrong_tenant');
  });

  it('closes behind the frozen preview: the hash must match, a stale hash is a conflict, a second close is invalid_state, and the ledger settles', async () => {
    const arena = await buildArena(h.database.db, { users: 4 });
    const contest = await inProgress(h.database.db, arena, { entryAmount: 100n, prizeStructure: { type: 'percentage_split', percentages: [60, 40] } });
    await score(h.database.db, arena, contest.id, [30, 20, 10, 5]);
    const { api, session } = await consoleClient(h, owner.db, 'operator');
    const base = `/console/tenants/${arena.tenantId}/contests/${contest.id}`;

    const preview = await api.get<PreviewResource>(`${base}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ state: 'awaiting_settlement', escrowTotal: '400' });
    expect(preview.data?.payouts.map((each) => [each.placement, each.payout])).toEqual([
      [1, '240'],
      [2, '160'],
      [3, '0'],
      [4, '0'],
    ]);
    const hash = preview.data?.payoutHash ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const stale = await api.post(`${base}/close`, { payoutHash: 'f'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.error).toMatchObject({ type: 'conflict', code: 'preview_hash_mismatch' });
    expect(await balanceOf(h.database.db, contest.escrowAccountId)).toBe(400n);
    const malformed = await api.post(`${base}/close`, { payoutHash: 'nope' });
    expect(malformed.status).toBe(400);

    const idempotencyKey = key('console-close');
    const closed = await api.post<ConsoleSettlementResource>(`${base}/close`, { payoutHash: hash }, { idempotencyKey });
    expect(closed.status).toBe(200);
    expect(closed.data).toMatchObject({ payoutHash: hash, replayed: false, contest: { state: 'settled', escrowBalance: '0' } });
    expect(closed.data?.journalEntryId).toMatch(/^je_/);
    expect(closed.data?.results.map((each) => each.payoutAmount)).toEqual(['240', '160', '0', '0']);
    expect(await balanceOf(h.database.db, contest.escrowAccountId)).toBe(0n);

    // The same request under the same key is the same settlement; a new request is refused.
    const replay = await api.post<ConsoleSettlementResource>(`${base}/close`, { payoutHash: hash }, { idempotencyKey });
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(replay.data?.journalEntryId).toBe(closed.data?.journalEntryId);
    const again = await api.post(`${base}/close`, { payoutHash: hash });
    expect(again.status).toBe(409);
    expect(again.error).toMatchObject({ type: 'invalid_state', code: 'already_settled' });

    // The settlement was recorded under the operator actor and the preview now reports what was paid.
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.subject, contest.id));
    expect(audit.some((row) => row.actorKind === 'operator' && row.actorRef === session.operator.id && JSON.stringify(row.after).includes('settled'))).toBe(true);
    const after = await api.get<PreviewResource>(`${base}/preview`);
    expect(after.data).toMatchObject({ state: 'settled', payoutHash: hash });
  });

  it('refuses a close from a contest that is not awaiting settlement, and moves a contest along with transition and void', async () => {
    const arena = await buildArena(h.database.db, { users: 2 });
    const contest = await makeContest(h.database.db, arena, { entryAmount: 25n });
    const { api } = await consoleClient(h, owner.db, 'operator');
    const base = `/console/tenants/${arena.tenantId}/contests/${contest.id}`;

    const early = await api.post(`${base}/close`, { payoutHash: 'a'.repeat(64) });
    expect(early.status).toBe(409);
    expect(early.error?.type).toBe('invalid_state');

    const opened = await api.post<ContestSummaryResource>(`${base}/transition`, { to: 'open', reason: 'console' });
    expect(opened.status).toBe(200);
    expect(opened.data?.state).toBe('open');
    const bad = await api.post(`${base}/transition`, { to: 'settled' });
    expect(bad.status).toBe(400);
    await advance(h.database.db, arena, contest.id, 'open');
    const withEntrants = await openWithEntrants(h.database.db, arena, { entryAmount: 25n });
    const voided = await api.post<VoidResource>(`/console/tenants/${arena.tenantId}/contests/${withEntrants.id}/void`, { reason: 'rained out' });
    expect(voided.status).toBe(200);
    expect(voided.data?.contest.state).toBe('voided');
    expect(voided.data?.refundJournalEntryIds).toHaveLength(2);
    expect(await balanceOf(h.database.db, withEntrants.escrowAccountId)).toBe(0n);
  });
});
