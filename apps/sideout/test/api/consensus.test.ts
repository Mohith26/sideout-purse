import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as listDisputes } from '../../src/app/api/admin/disputes/route';
import { POST as retryPush } from '../../src/app/api/admin/matches/[id]/purse/retry/route';
import { POST as resolve } from '../../src/app/api/admin/matches/[id]/resolve/route';
import { GET as closePreview } from '../../src/app/api/admin/tournaments/[id]/close/preview/route';
import { GET as closeStatus, POST as close } from '../../src/app/api/admin/tournaments/[id]/close/route';
import { POST as draw } from '../../src/app/api/admin/tournaments/[id]/draw/route';
import { GET as purseView } from '../../src/app/api/admin/tournaments/[id]/purse/route';
import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { GET as listCalls } from '../../src/app/api/admin/purse/calls/route';
import { POST as submitScores } from '../../src/app/api/matches/[id]/scores/route';
import { GET as getMatch } from '../../src/app/api/matches/[id]/route';
import { POST as linkPurse } from '../../src/app/api/me/purse/link/route';
import { GET as purseProfile } from '../../src/app/api/me/purse/route';
import { POST as readBackEntries } from '../../src/app/api/teams/[id]/purse/entries/route';
import { auditLog, matchConsensus, matches, purseCalls, scoreSubmissions, sets, teamMembers, tournaments, users, type Charity, type User } from '../../src/db/schema';
import { databaseCallRecorder, PurseClient } from '../../src/purse';
import type { ConsensusView } from '../../src/server/consensus';
import { appContext, resetAppContext } from '../../src/server/context';
import type { DrawOutcome } from '../../src/server/draw';
import type { CloseBlocker, ClosePreview } from '../../src/server/purse/close';
import { cookieFor, createCharity, createUser, data, errorOf, expectNoPurseKeys, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { FakePurse } from '../purse/fake-purse';
import { registerTeams, tournamentBody } from './fixtures';

type MatchResponse = { match: { id: string; status: string; winnerTeamId: string | null; teamAId: string | null; teamBId: string | null; sets: unknown[] }; consensus: ConsensusView | null; viewerSide: 'a' | 'b' | null };
type SubmitResponse = { outcome: string; replaced: boolean; consensus: ConsensusView; match: { status: string; winnerTeamId: string | null }; purse: { status: string; error?: { code: string } } | null };
type BracketMatch = { id: string; round: number; teamAId: string | null; teamBId: string | null; status: string };

describe('score consensus and the Purse wiring', () => {
  let database: Database;
  let organizer: User;
  let charity: Charity;
  let fake: FakePurse;

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    fake = new FakePurse();
    usePurse(fake);
    organizer = await createUser(database, { role: 'organizer' });
    charity = await createCharity(database);
  });
  afterAll(async () => {
    await database.close();
  });

  function usePurse(purse: FakePurse): void {
    resetAppContext({ purse: new PurseClient({ baseUrl: 'http://purse.test', secretKey: purse.secretKey, recorder: databaseCallRecorder(database.db), fetch: purse.fetch }) });
  }

  const organizerCookie = () => cookieFor(organizer);
  const patch = (id: string, body: Record<string, unknown>) => patchTournament(request('PATCH', '/x', { body, cookie: organizerCookie() }), params({ id }));

  /** A single-elimination tournament of four teams, live, its bracket drawn, every player linked and entered in the fake Purse. */
  async function liveBracket(options: { enter?: boolean } = {}): Promise<{ id: string; slug: string; teamIds: string[]; bracket: BracketMatch[]; captains: Map<string, User>; players: Map<string, User> }> {
    const { tournament } = await data<{ tournament: { id: string; slug: string } }>(
      await createTournament(request('POST', '/x', { body: tournamentBody(charity, { format: 'single_elim', maxTeams: 4, entryDonationCents: '0' }), cookie: organizerCookie() })),
    );
    await data(await patch(tournament.id, { status: 'registration_open' }));
    const teamIds = await registerTeams(database, tournament.id, 4, { 0: 1, 1: 2, 2: 3, 3: 4 });
    const captains = new Map<string, User>();
    const players = new Map<string, User>();
    for (const teamId of teamIds) {
      const members = await database.db.select({ member: teamMembers, user: users }).from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId)).where(eq(teamMembers.teamId, teamId));
      for (const { member, user } of members) {
        (member.role === 'captain' ? captains : players).set(teamId, user);
        await data(await linkPurse(request('POST', '/x', { cookie: cookieFor(user) })));
      }
    }
    await data(await patch(tournament.id, { status: 'registration_closed' }));
    const contest = fake.contestByExternalId((await database.db.select().from(tournaments).where(eq(tournaments.id, tournament.id)))[0]?.purseExternalId ?? '');
    if (contest === undefined) throw new Error('the contest was not created in Purse');
    if (options.enter !== false) {
      const client = appContext().purse;
      if (client === null) throw new Error('no purse client');
      for (const user of [...captains.values(), ...players.values()]) {
        const fresh = (await database.db.select().from(users).where(eq(users.id, user.id)))[0];
        if (fresh?.purseUserId === null || fresh?.purseUserId === undefined) throw new Error('user not linked');
        await client.enterContest(contest.id, { userId: fresh.purseUserId }, { requestId: 'test', idempotencyKey: `entry:${user.id}` });
      }
      for (const teamId of teamIds) {
        const captain = captains.get(teamId);
        if (captain === undefined) throw new Error('no captain');
        const entries = await data<{ complete: boolean }>(await readBackEntries(request('POST', '/x', { cookie: cookieFor(captain) }), params({ id: teamId })));
        expect(entries.complete).toBe(true);
      }
    }
    await data<DrawOutcome>(await draw(request('POST', '/x', { body: { stage: 'bracket', courts: 2, rngSeed: 3 }, cookie: organizerCookie() }), params({ id: tournament.id })));
    await data(await patch(tournament.id, { status: 'live' }));
    const rows = await database.db.select().from(matches).where(eq(matches.tournamentId, tournament.id)).orderBy(asc(matches.bracketPosition));
    const bracket = rows.map((m) => ({ id: m.id, round: m.round, teamAId: m.teamAId, teamBId: m.teamBId, status: m.status }));
    return { ...tournament, teamIds, bracket, captains, players };
  }

  const submit = (matchId: string, user: User, sets: Array<{ setNumber: number; usPoints: number; themPoints: number }>) =>
    submitScores(request('POST', '/x', { body: { sets }, cookie: cookieFor(user) }), params({ id: matchId }));

  const WIN = [{ setNumber: 1, usPoints: 21, themPoints: 18 }, { setNumber: 2, usPoints: 21, themPoints: 15 }];
  const LOSS = [{ setNumber: 1, usPoints: 18, themPoints: 21 }, { setNumber: 2, usPoints: 15, themPoints: 21 }];

  it('rejects an illegal scoreline with a specific message before anything is stored or pushed', async () => {
    const t = await liveBracket();
    const match = t.bracket.find((m) => m.round === 1);
    if (match?.teamAId === null || match?.teamAId === undefined) throw new Error('no match');
    const captain = t.captains.get(match.teamAId);
    if (captain === undefined) throw new Error('no captain');
    const before = fake.requests.length;
    const error = await errorOf(await submit(match.id, captain, [{ setNumber: 1, usPoints: 21, themPoints: 20 }, { setNumber: 2, usPoints: 21, themPoints: 15 }]));
    expect(error).toMatchObject({ type: 'invalid_request', code: 'illegal_scoreline' });
    expect(error.message).toMatch(/Set 1: Sets are won by 2/);
    expect(await database.db.select().from(scoreSubmissions)).toHaveLength(0);
    expect(await database.db.select().from(matchConsensus)).toHaveLength(0);
    expect(fake.requests.length).toBe(before);
    const stillScheduled = await data<MatchResponse>(await getMatch(request('GET', '/x'), params({ id: match.id })));
    expect(stillScheduled.match.status).toBe('scheduled');
    // A best-of-three needs two set wins; a validation failure is refused by the schema before the rules.
    expect(await errorOf(await submit(match.id, captain, [{ setNumber: 1, usPoints: 21, themPoints: 18 }]))).toMatchObject({ code: 'illegal_scoreline' });
    expect(await errorOf(await submit(match.id, captain, [{ setNumber: 1, usPoints: 210, themPoints: 18 }]))).toMatchObject({ code: 'validation_failed' });
  });

  it('two submissions from one team never reach consensus; the second only replaces the first', async () => {
    const t = await liveBracket();
    const match = t.bracket.find((m) => m.round === 1);
    if (match?.teamAId === null || match?.teamAId === undefined) throw new Error('no match');
    const captain = t.captains.get(match.teamAId);
    const partner = t.players.get(match.teamAId);
    if (captain === undefined || partner === undefined) throw new Error('no team A');
    const first = await data<SubmitResponse>(await submit(match.id, captain, WIN));
    expect(first.outcome).toBe('awaiting_second');
    expect(first.match.status).toBe('awaiting_scores');
    const second = await data<SubmitResponse>(await submit(match.id, partner, WIN));
    expect(second.outcome).toBe('awaiting_second');
    expect(second.replaced).toBe(true);
    expect(second.consensus.state).toBe('awaiting_second');
    const rows = await database.db.select().from(scoreSubmissions).orderBy(asc(scoreSubmissions.createdAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.supersededById).toBe(rows[1]?.id);
    expect(rows[1]?.supersededById).toBeNull();
    expect(rows.every((r) => r.submittedForTeamId === match.teamAId)).toBe(true);
    expect(fake.requestsTo(/scores$/)).toHaveLength(0);
    // Nobody outside the two teams may submit at all, and the organizer is not on a team.
    const outsider = await createUser(database);
    expect(await errorOf(await submit(match.id, outsider, WIN))).toMatchObject({ type: 'permission_error', code: 'not_on_team' });
    expect(await errorOf(await submit(match.id, organizer, WIN))).toMatchObject({ code: 'not_on_team' });
  });

  it('agreement by hash: the other team’s honest view finalises the match, mints one key, pushes and confirms with Purse', async () => {
    const t = await liveBracket();
    const match = t.bracket.find((m) => m.round === 1);
    if (match?.teamAId === null || match?.teamAId === undefined || match.teamBId === null) throw new Error('no match');
    const a = t.captains.get(match.teamAId);
    const b = t.players.get(match.teamBId);
    if (a === undefined || b === undefined) throw new Error('no players');
    await data(await submit(match.id, a, WIN));
    const agreed = await data<SubmitResponse>(await submit(match.id, b, LOSS));
    expect(agreed.outcome).toBe('agreed');
    expect(agreed.match.status).toBe('final');
    expect(agreed.match.winnerTeamId).toBe(match.teamAId);
    expect(agreed.purse).toEqual({ status: 'confirmed' });
    expect(agreed.consensus.state).toBe('confirmed');
    expect(agreed.consensus.pushedAt).not.toBeNull();
    expect(agreed.consensus.confirmedAt).not.toBeNull();
    expectNoPurseKeys(agreed.consensus);

    const [row] = await database.db.select().from(matchConsensus).where(eq(matchConsensus.matchId, match.id));
    expect(row?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.agreedHash).toMatch(/^[0-9a-f]{64}$/);
    const setRows = await database.db.select().from(sets).where(eq(sets.matchId, match.id));
    expect(setRows.map((s) => [s.setNumber, s.teamAPoints, s.teamBPoints, s.agreed])).toEqual([[1, 21, 18, true], [2, 21, 15, true]]);

    // The winner advanced into the final.
    const [next] = await database.db.select().from(matches).where(eq(matches.id, (await database.db.select().from(matches).where(eq(matches.id, match.id)))[0]?.nextMatchId ?? ''));
    expect([next?.teamAId, next?.teamBId]).toContain(match.teamAId);

    // The push: two identical requests under the consensus key; the second was Purse's replay, creating nothing new.
    const pushes = fake.requestsTo(/\/scores$/, 'POST');
    expect(pushes).toHaveLength(2);
    expect(pushes.map((p) => p.idempotencyKey)).toEqual([row?.idempotencyKey, row?.idempotencyKey]);
    expect(pushes.map((p) => p.replayed)).toEqual([false, true]);
    const contest = fake.contestByExternalId((await database.db.select().from(tournaments).where(eq(tournaments.id, t.id)))[0]?.purseExternalId ?? '');
    expect(contest?.scores.filter((s) => !s.superseded)).toHaveLength(4);
    expect(contest?.scores.filter((s) => !s.superseded).every((s) => !s.attemptFinished)).toBe(true);
    // Winners carry one win, losers none.
    const body = pushes[0]?.body as { scores: Array<{ userId: string; score: number; attemptFinished: boolean; sourceRef: string }> };
    expect(body.scores.map((s) => s.score).sort()).toEqual([0, 0, 1, 1]);
    expect(body.scores.every((s) => !s.attemptFinished && s.sourceRef === match.id)).toBe(true);

    // Every transition is in the audit log, and the calls in purse_calls.
    const trail = (await database.db.select().from(auditLog).where(eq(auditLog.subjectId, match.id))).map((r) => [r.action, r.actorKind, (r.detail as { to?: string }).to ?? null]);
    expect(trail).toEqual(
      expect.arrayContaining([
        ['consensus.state_changed', 'player', 'awaiting_second'],
        ['consensus.state_changed', 'player', 'agreed'],
        ['match.status_changed', 'system', 'final'],
        ['consensus.state_changed', 'system', 'pushed_to_purse'],
        ['consensus.state_changed', 'system', 'confirmed'],
      ]),
    );
    const calls = await database.db.select().from(purseCalls).where(eq(purseCalls.subjectId, match.id));
    expect(calls.map((c) => [c.path.endsWith('/scores'), c.status, c.replayed])).toEqual([[true, 'succeeded', false], [true, 'succeeded', true]]);
    expect(JSON.stringify(calls)).not.toContain(fake.secretKey);

    // Nothing more can be submitted.
    expect(await errorOf(await submit(match.id, a, WIN))).toMatchObject({ type: 'invalid_state', code: 'already_decided' });
  });

  it('a differing hash is a dispute with the differing set recorded; the organizer resolves it, attributed, and the result is pushed', async () => {
    const t = await liveBracket();
    const match = t.bracket.find((m) => m.round === 1);
    if (match?.teamAId === null || match?.teamAId === undefined || match.teamBId === null) throw new Error('no match');
    const a = t.captains.get(match.teamAId);
    const b = t.captains.get(match.teamBId);
    if (a === undefined || b === undefined) throw new Error('no players');
    await data(await submit(match.id, a, WIN));
    const disputed = await data<SubmitResponse>(await submit(match.id, b, [{ setNumber: 1, usPoints: 18, themPoints: 21 }, { setNumber: 2, usPoints: 17, themPoints: 21 }]));
    expect(disputed.outcome).toBe('disputed');
    expect(disputed.match.status).toBe('disputed');
    expect(disputed.consensus.disputedReason).toBe('Set 2 differs: 21–15 vs 21–17');
    expect(disputed.consensus.differences).toEqual([{ setNumber: 2, a: { setNumber: 2, teamAPoints: 21, teamBPoints: 15 }, b: { setNumber: 2, teamAPoints: 21, teamBPoints: 17 } }]);
    expect(disputed.purse).toBeNull();
    expect(fake.requestsTo(/\/scores$/)).toHaveLength(0);

    const queue = await data<{ disputes: Array<{ match: { id: string }; teamA: { name: string } | null; consensus: ConsensusView }> }>(await listDisputes(request('GET', '/x', { cookie: organizerCookie() })));
    expect(queue.disputes.map((d) => d.match.id)).toEqual([match.id]);
    expect(queue.disputes[0]?.consensus.live.map((s) => s.teamId)).toEqual([match.teamAId, match.teamBId]);
    expect(await errorOf(await listDisputes(request('GET', '/x', { cookie: cookieFor(a) })))).toMatchObject({ code: 'organizer_required' });

    // A player may not resolve; a wrong scoreline is still judged; the organizer's resolution is attributed.
    expect(await errorOf(await resolve(request('POST', '/x', { body: { sets: [{ setNumber: 1, teamAPoints: 21, teamBPoints: 18 }, { setNumber: 2, teamAPoints: 21, teamBPoints: 17 }] }, cookie: cookieFor(a) }), params({ id: match.id })))).toMatchObject({ code: 'organizer_required' });
    expect(await errorOf(await resolve(request('POST', '/x', { body: { sets: [{ setNumber: 1, teamAPoints: 21, teamBPoints: 20 }] }, cookie: organizerCookie() }), params({ id: match.id })))).toMatchObject({ code: 'illegal_scoreline' });
    const resolved = await data<{ consensus: ConsensusView; match: { status: string; winnerTeamId: string | null }; purse: { status: string } }>(
      await resolve(request('POST', '/x', { body: { sets: [{ setNumber: 1, teamAPoints: 21, teamBPoints: 18 }, { setNumber: 2, teamAPoints: 21, teamBPoints: 17 }] }, cookie: organizerCookie() }), params({ id: match.id })),
    );
    expect(resolved.match).toMatchObject({ status: 'final', winnerTeamId: match.teamAId });
    expect(resolved.consensus.state).toBe('confirmed');
    expect(resolved.consensus.resolvedBy).toEqual({ userId: organizer.id, displayName: organizer.displayName });
    expect(resolved.consensus.disputedReason).toBeNull();
    expect(resolved.purse.status).toBe('confirmed');
    const resolution = (await database.db.select().from(auditLog).where(eq(auditLog.subjectId, match.id))).find((r) => r.action === 'consensus.state_changed' && (r.detail as { to: string }).to === 'agreed');
    expect(resolution).toMatchObject({ actorKind: 'organizer', actorUserId: organizer.id });
    expect(resolution?.detail).toMatchObject({ event: 'organizer_resolution', resolvedByUserId: organizer.id, mintedKey: true });
    expect((await database.db.select().from(scoreSubmissions).where(eq(scoreSubmissions.matchId, match.id))).filter((s) => s.submittedForTeamId === null)).toHaveLength(1);
    expect(await errorOf(await resolve(request('POST', '/x', { body: { sets: [{ setNumber: 1, teamAPoints: 21, teamBPoints: 18 }, { setNumber: 2, teamAPoints: 21, teamBPoints: 17 }] }, cookie: organizerCookie() }), params({ id: match.id })))).toMatchObject({ code: 'invalid_transition' });
    expect((await data<{ disputes: unknown[] }>(await listDisputes(request('GET', '/x', { cookie: organizerCookie() })))).disputes).toEqual([]);
  });

  it('a push that fails leaves the consensus agreed with the failure recorded; the organizer’s retry reuses the key; a lost confirmation retries alone', async () => {
    const t = await liveBracket();
    const match = t.bracket.find((m) => m.round === 1);
    if (match?.teamAId === null || match?.teamAId === undefined || match.teamBId === null) throw new Error('no match');
    const a = t.captains.get(match.teamAId);
    const b = t.captains.get(match.teamBId);
    if (a === undefined || b === undefined) throw new Error('no players');
    await data(await submit(match.id, a, WIN));
    fake.failNext = 1;
    const agreed = await data<SubmitResponse>(await submit(match.id, b, LOSS));
    expect(agreed.outcome).toBe('agreed');
    expect(agreed.match.status).toBe('final');
    expect(agreed.purse).toMatchObject({ status: 'agreed', error: { code: 'purse_unreachable' } });
    expect(agreed.consensus.state).toBe('agreed');
    expect(agreed.consensus.lastPushError).toMatchObject({ code: 'purse_unreachable' });
    const [row] = await database.db.select().from(matchConsensus).where(eq(matchConsensus.matchId, match.id));
    const key = row?.idempotencyKey ?? '';
    expect(key).not.toBe('');
    const failed = await database.db.select().from(purseCalls).where(eq(purseCalls.subjectId, match.id));
    expect(failed.map((c) => [c.status, c.idempotencyKey, c.error])).toEqual([['failed', key, 'TypeError: fetch failed: connection refused']]);

    // Retry as a player: refused. As the organizer, with the confirmation failing this time: pushed but not confirmed.
    expect(await errorOf(await retryPush(request('POST', '/x', { cookie: cookieFor(a) }), params({ id: match.id })))).toMatchObject({ code: 'organizer_required' });
    fake.failNext = 0;
    const firstRetry = await data<{ purse: { status: string }; consensus: ConsensusView }>(await retryPush(request('POST', '/x', { cookie: organizerCookie() }), params({ id: match.id })));
    // The push succeeded; make the confirmation fail by breaking the next request after it.
    expect(firstRetry.consensus.state).toBe('confirmed');
    expect(fake.requestsTo(/\/scores$/, 'POST').map((p) => p.idempotencyKey)).toEqual([key, key, key]);
    expect(fake.requestsTo(/\/scores$/, 'POST').map((p) => p.replayed)).toEqual([false, false, true]);
    expect(await errorOf(await retryPush(request('POST', '/x', { cookie: organizerCookie() }), params({ id: match.id })))).toMatchObject({ code: 'not_retryable' });

    // A second match: the push lands, the confirmation does not, and the retry confirms without pushing again.
    const other = t.bracket.find((m) => m.round === 1 && m.id !== match.id);
    if (other?.teamAId === null || other?.teamAId === undefined || other.teamBId === null) throw new Error('no other match');
    const c = t.captains.get(other.teamAId);
    const d = t.captains.get(other.teamBId);
    if (c === undefined || d === undefined) throw new Error('no players');
    await data(await submit(other.id, c, WIN));
    const scoresPath = `/v1/contests/${fake.contestByExternalId((await database.db.select().from(tournaments).where(eq(tournaments.id, t.id)))[0]?.purseExternalId ?? '')?.id ?? ''}/scores`;
    const pushesBefore = fake.requestsTo(/\/scores$/, 'POST').length;
    // Fail the confirmation: the push is the first scores request after the ones so far, the confirmation the second.
    fake.failWhen = (r) => r.path === scoresPath && r.seen === pushesBefore + 1;
    const pushedOnly = await data<SubmitResponse>(await submit(other.id, d, LOSS));
    fake.failWhen = null;
    expect(pushedOnly.purse).toMatchObject({ status: 'pushed_to_purse', error: { code: 'purse_unreachable' } });
    expect(pushedOnly.consensus.state).toBe('pushed_to_purse');
    const confirmed = await data<{ purse: { status: string }; consensus: ConsensusView }>(await retryPush(request('POST', '/x', { cookie: organizerCookie() }), params({ id: other.id })));
    expect(confirmed.consensus.state).toBe('confirmed');
    // The push, the confirmation that never answered, then the retry: the same batch under the same key, both answered from Purse's store.
    const otherPushes = fake.requestsTo(/\/scores$/, 'POST').filter((p) => (p.body as { scores: Array<{ sourceRef: string }> }).scores[0]?.sourceRef === other.id);
    expect(otherPushes.map((p) => [p.idempotencyKey === otherPushes[0]?.idempotencyKey, p.replayed, p.status])).toEqual([[true, false, 201], [true, false, 0], [true, true, 201], [true, true, 201]]);
  });

  it('close is blocked while any match is disputed or unconfirmed, naming each; the preview freezes Purse’s hash and the close confirms it', async () => {
    const t = await liveBracket();
    const round1 = t.bracket.filter((m) => m.round === 1);
    const [m1, m2] = round1;
    if (m1?.teamAId === null || m1?.teamAId === undefined || m1.teamBId === null || m2?.teamAId === null || m2?.teamAId === undefined || m2.teamBId === null) throw new Error('no matches');
    const cap = (teamId: string): User => {
      const u = t.captains.get(teamId);
      if (u === undefined) throw new Error('no captain');
      return u;
    };
    // Match 1 agreed and confirmed; match 2 disputed.
    await data(await submit(m1.id, cap(m1.teamAId), WIN));
    await data(await submit(m1.id, cap(m1.teamBId), LOSS));
    await data(await submit(m2.id, cap(m2.teamAId), WIN));
    await data(await submit(m2.id, cap(m2.teamBId), [{ setNumber: 1, usPoints: 18, themPoints: 21 }, { setNumber: 2, usPoints: 10, themPoints: 21 }]));

    // Not yet awaiting settlement: the preview says so.
    expect(await errorOf(await closePreview(request('GET', '/x', { cookie: organizerCookie() }), params({ id: t.id })))).toMatchObject({ type: 'invalid_state', code: 'tournament_not_awaiting_settlement' });
    // The tournament cannot even reach awaiting_settlement with a disputed match and an unplayed final.
    expect(await errorOf(await patch(t.id, { status: 'awaiting_settlement' }))).toMatchObject({ code: 'matches_unresolved' });
    const status = await data<{ blockers: CloseBlocker[]; frozen: unknown }>(await closeStatus(request('GET', '/x', { cookie: organizerCookie() }), params({ id: t.id })));
    expect(status.blockers.map((b) => [b.matchId, b.matchStatus, b.consensusState])).toEqual(expect.arrayContaining([[m2.id, 'disputed', 'disputed']]));
    expect(status.blockers.find((b) => b.matchId === m2.id)?.reason).toMatch(/resolve the dispute/);
    expect(status.frozen).toBeNull();

    // Resolve, play the final, move on.
    await data(await resolve(request('POST', '/x', { body: { sets: [{ setNumber: 1, teamAPoints: 21, teamBPoints: 18 }, { setNumber: 2, teamAPoints: 21, teamBPoints: 10 }] }, cookie: organizerCookie() }), params({ id: m2.id })));
    const [finalRow] = await database.db.select().from(matches).where(eq(matches.id, t.bracket.find((m) => m.round === 2)?.id ?? ''));
    if (finalRow?.teamAId === null || finalRow?.teamAId === undefined || finalRow.teamBId === null) throw new Error('final not populated');
    await data(await submit(finalRow.id, cap(finalRow.teamAId), WIN));
    // Make the final's confirmation fail so it blocks the close as "pushed, not confirmed".
    fake.failNext = 0;
    await data(await submit(finalRow.id, cap(finalRow.teamBId), LOSS));
    await database.db.update(matchConsensus).set({ state: 'pushed_to_purse', confirmedAt: null }).where(eq(matchConsensus.matchId, finalRow.id));
    await data(await patch(t.id, { status: 'awaiting_settlement' }));
    const blocked = await errorOf(await closePreview(request('GET', '/x', { cookie: organizerCookie() }), params({ id: t.id })));
    expect(blocked).toMatchObject({ type: 'invalid_state', code: 'close_blocked' });
    expect(blocked.message).toMatch(/Bracket · round 2/);
    expect((blocked.detail as { blockers: CloseBlocker[] }).blockers.map((b) => [b.matchId, b.consensusState])).toEqual([[finalRow.id, 'pushed_to_purse']]);
    await data(await retryPush(request('POST', '/x', { cookie: organizerCookie() }), params({ id: finalRow.id })));

    // The preview: final standings pushed as finished attempts, Purse's hash frozen.
    const preview = await data<ClosePreview>(await closePreview(request('GET', '/x', { cookie: organizerCookie() }), params({ id: t.id })));
    expect(preview.blockers).toEqual([]);
    expect(preview.payoutHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.contestState).toBe('awaiting_settlement');
    expect(preview.standings.map((s) => s.placement)).toEqual([1, 2, 3, 3]);
    expect(preview.standings[0]?.teamId).toBe(finalRow.winnerTeamId ?? m1.teamAId);
    expect(preview.entries.every((e) => e.attemptFinished)).toBe(true);
    expect(preview.payouts.reduce((sum, p) => sum + BigInt(p.payout), 0n)).toBe(BigInt(preview.escrowTotal));
    expect(preview.escrowTotal).toBe('800');
    const winners = preview.standings[0]?.players.map((p) => p.purseUserId) ?? [];
    expect(preview.payouts.filter((p) => p.placement === 1).map((p) => p.userId).sort()).toEqual([...winners].sort());
    const [frozen] = await database.db.select({ preview: tournaments.purseClosePreview }).from(tournaments).where(eq(tournaments.id, t.id));
    expect(frozen?.preview?.payoutHash).toBe(preview.payoutHash);
    const finalPush = fake.requestsTo(/\/scores$/, 'POST').at(-1);
    expect((finalPush?.body as { scores: Array<{ attemptFinished: boolean }> }).scores.every((s) => s.attemptFinished)).toBe(true);
    // A second preview replays the final push and creates nothing new.
    const again = await data<ClosePreview>(await closePreview(request('GET', '/x', { cookie: organizerCookie() }), params({ id: t.id })));
    expect(again.payoutHash).toBe(preview.payoutHash);
    expect(fake.requestsTo(/\/scores$/, 'POST').at(-1)?.replayed).toBe(true);

    // A hash the organizer did not see is refused by Sideout; a stale one by Purse.
    expect(await errorOf(await close(request('POST', '/x', { body: { payoutHash: 'f'.repeat(64) }, cookie: organizerCookie() }), params({ id: t.id })))).toMatchObject({ type: 'conflict', code: 'preview_hash_mismatch' });
    const contest = fake.contestByExternalId((await database.db.select().from(tournaments).where(eq(tournaments.id, t.id)))[0]?.purseExternalId ?? '');
    if (contest === undefined) throw new Error('no contest');
    const savedEscrow = contest.escrow;
    contest.escrow += 1n;
    const stale = await errorOf(await close(request('POST', '/x', { body: { payoutHash: preview.payoutHash }, cookie: organizerCookie() }), params({ id: t.id })));
    expect(stale).toMatchObject({ type: 'conflict', code: 'preview_hash_mismatch' });
    expect((await database.db.select({ preview: tournaments.purseClosePreview }).from(tournaments).where(eq(tournaments.id, t.id)))[0]?.preview).toBeNull();
    contest.escrow = savedEscrow;

    // Preview again, then close: Purse settles, the tournament is settled by the system.
    const fresh = await data<ClosePreview>(await closePreview(request('GET', '/x', { cookie: organizerCookie() }), params({ id: t.id })));
    const closed = await data<{ status: string; settlement: { contestState: string; payoutHash: string; results: Array<{ placement: number; payoutAmount: string }> } }>(
      await close(request('POST', '/x', { body: { payoutHash: fresh.payoutHash }, cookie: organizerCookie() }), params({ id: t.id })),
    );
    expect(closed.status).toBe('settled');
    expect(closed.settlement.contestState).toBe('settled');
    expect(closed.settlement.payoutHash).toBe(fresh.payoutHash);
    expect(closed.settlement.results.reduce((sum, r) => sum + BigInt(r.payoutAmount), 0n)).toBe(800n);
    expect(contest.state).toBe('settled');
    expect(contest.escrow).toBe(0n);
    const settledAudit = (await database.db.select().from(auditLog).where(eq(auditLog.subjectId, t.id))).filter((r) => r.action === 'tournament.status_changed').at(-1);
    expect(settledAudit).toMatchObject({ actorKind: 'system', detail: { from: 'awaiting_settlement', to: 'settled' } });
    // The close replays under its key.
    const replay = await data<{ replayed: boolean }>(await close(request('POST', '/x', { body: { payoutHash: fresh.payoutHash }, cookie: organizerCookie() }), params({ id: t.id })));
    expect(replay.replayed).toBe(true);
    const view = await data<{ reconciliation: { missing: unknown[]; extra: unknown[] }; blockers: unknown[] }>(await purseView(request('GET', '/x', { cookie: organizerCookie() }), params({ id: t.id })));
    expect(view.reconciliation.missing).toEqual([]);
    expect(view.reconciliation.extra).toEqual([]);
    expect(view.blockers).toEqual([]);
  });

  it('mirrors the tournament to Purse: contest created and opened at registration, locked and started at live, voided on cancellation; a failure is audited, never fatal', async () => {
    const { tournament } = await data<{ tournament: { id: string; slug: string } }>(
      await createTournament(request('POST', '/x', { body: tournamentBody(charity, { format: 'single_elim', maxTeams: 4, entryDonationCents: '0' }), cookie: organizerCookie() })),
    );
    fake.failNext = 1;
    const opened = await data<{ purse: { status: string } }>(await patch(tournament.id, { status: 'registration_open' }));
    expect(opened.purse).toMatchObject({ status: 'failed', error: { code: 'purse_unreachable' } });
    expect((await database.db.select().from(auditLog).where(eq(auditLog.subjectId, tournament.id))).some((r) => r.action === 'tournament.purse_mirror_failed')).toBe(true);
    let [row] = await database.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    expect(row?.purseContestId).toBeNull();
    // The next transition runs the mirror again: created and opened under fixed keys.
    const closedReg = await data<{ purse: { status: string; contestState: string } }>(await patch(tournament.id, { status: 'registration_closed' }));
    expect(closedReg.purse).toMatchObject({ status: 'mirrored', contestState: 'open' });
    [row] = await database.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    expect(row?.purseContestId).toMatch(/^cnt_/);
    expect(row?.purseContestState).toBe('open');
    const created = fake.requestsTo(/^\/v1\/contests$/, 'POST')[0]?.body as { externalId: string; asset: string; entryAmount: string; prizeStructure: unknown; settlementPolicy: string; kind: string };
    expect(created).toMatchObject({ externalId: row?.purseExternalId, asset: 'POINTS', entryAmount: '100', settlementPolicy: 'operator_close', kind: 'tournament', prizeStructure: { type: 'placement_table' } });
    expect((created.prizeStructure as { placements: Array<{ amount: string }> }).placements.map((p) => p.amount)).toEqual(['50', '50', '30', '30', '20', '20']);
    // Reopening registration leaves the contest open (Purse has no unlock), and going live locks then starts it.
    await data(await patch(tournament.id, { status: 'registration_open' }));
    expect(fake.contestByExternalId(row?.purseExternalId ?? '')?.state).toBe('open');
    await registerTeams(database, tournament.id, 4);
    await data(await patch(tournament.id, { status: 'registration_closed' }));
    await data(await draw(request('POST', '/x', { body: { stage: 'bracket' }, cookie: organizerCookie() }), params({ id: tournament.id })));
    const live = await data<{ purse: { status: string; contestState: string } }>(await patch(tournament.id, { status: 'live' }));
    expect(live.purse).toMatchObject({ status: 'mirrored', contestState: 'in_progress' });
    // Cancelling voids it.
    const cancelled = await data<{ purse: { status: string; contestState: string } }>(await patch(tournament.id, { status: 'cancelled' }));
    expect(cancelled.purse).toMatchObject({ status: 'mirrored', contestState: 'voided' });
    expect((await database.db.select().from(auditLog).where(eq(auditLog.subjectId, tournament.id))).some((r) => r.action === 'tournament.purse_contest_voided')).toBe(true);
  });

  it('links a user to Purse once, grants the welcome points once, reads the profile back, and lists every call for the admin page', async () => {
    const player = await createUser(database, { displayName: 'Maya Delgado' });
    const first = await data<{ linked: boolean; verification: { state: string }; wallet: Array<{ asset: string; balance: string }> }>(await linkPurse(request('POST', '/x', { cookie: cookieFor(player) })));
    expect(first.linked).toBe(true);
    expect(first.verification.state).toBe('unstarted');
    expect(first.wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1000');
    const second = await data<{ wallet: Array<{ asset: string; balance: string }> }>(await linkPurse(request('POST', '/x', { cookie: cookieFor(player) })));
    expect(second.wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1000');
    expect(fake.requestsTo(/\/credits$/, 'POST').map((r) => r.replayed)).toEqual([false, true]);
    const [row] = await database.db.select().from(users).where(eq(users.id, player.id));
    expect(row?.purseUserId).toMatch(/^usr_/);
    expect(Object.keys(row ?? {})).not.toContain('purseWallet');
    expect((await database.db.select().from(auditLog).where(eq(auditLog.subjectId, player.id))).filter((r) => r.action === 'user.purse_linked')).toHaveLength(1);
    const profile = await data<{ linked: boolean; wallet: Array<{ asset: string }> }>(await purseProfile(request('GET', '/x', { cookie: cookieFor(player) })));
    expect(profile.linked).toBe(true);
    expect(profile.wallet.map((b) => b.asset)).toEqual(['POINTS', 'CREDIT']);

    const calls = await data<{ calls: Array<{ method: string; path: string; status: string; idempotencyKey: string | null; request: unknown; response: unknown }>; nextBefore: string | null }>(
      await listCalls(request('GET', '/x?limit=3', { cookie: organizerCookie() })),
    );
    expect(calls.calls).toHaveLength(3);
    expect(calls.nextBefore).not.toBeNull();
    expect(calls.calls.every((c) => c.status === 'succeeded')).toBe(true);
    expect(calls.calls.map((c) => [c.method, c.path.endsWith('/wallet')])).toEqual([['GET', true], ['GET', false], ['GET', true]]);
    expect(calls.calls[1]?.path).toMatch(/^\/v1\/users\/usr_/);
    expect(JSON.stringify(calls)).not.toContain(fake.secretKey);
    expect(await errorOf(await listCalls(request('GET', '/x', { cookie: cookieFor(player) })))).toMatchObject({ code: 'organizer_required' });

    // Without a configured Purse the routes say so.
    resetAppContext({ purse: null });
    expect(await errorOf(await linkPurse(request('POST', '/x', { cookie: cookieFor(player) })))).toMatchObject({ type: 'internal_error', code: 'purse_unavailable' });
  });
});
