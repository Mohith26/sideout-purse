import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as challengePost } from '../../src/app/api/seasons/[seasonId]/challenges/route';
import { POST as closePost } from '../../src/app/api/seasons/[seasonId]/close/route';
import { POST as previewPost } from '../../src/app/api/seasons/[seasonId]/close/preview/route';
import { POST as syncPost } from '../../src/app/api/seasons/[seasonId]/entries/sync/route';
import { POST as startPost } from '../../src/app/api/seasons/[seasonId]/start/route';
import { GET as currentGet } from '../../src/app/api/seasons/current/route';
import { POST as seasonsPost } from '../../src/app/api/seasons/route';
import { POST as confirmPost } from '../../src/app/api/matches/[matchId]/confirm/route';
import { POST as reportPost } from '../../src/app/api/matches/[matchId]/report/route';
import { POST as linkPost } from '../../src/app/api/me/purse/link/route';
import { GET as profileGet } from '../../src/app/api/me/purse/route';
import { GET as callsGet } from '../../src/app/api/purse-calls/route';
import { POST as sessionPost } from '../../src/app/api/session/route';
import { players } from '../../src/db/schema';
import { env } from '../../src/env';
import { resetAppContext } from '../../src/server/context';
import type { SeasonView } from '../../src/server/seasons';
import { cookieFor, createPlayer, data, errorOf, fakePurse, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import type { FakePurse } from '../purse/fake-purse';

/**
 * A season end to end against the in-memory Purse: two players sign in and link, enter
 * the season (as the embed's entry flow would, on Purse's side) and are read back onto
 * the ladder, the commissioner starts play, the lower player challenges, wins and moves
 * up, the running scores are pushed under the match's key, and the season closes through
 * the frozen preview with the payouts landing in the players' Purse wallets.
 */
let database: Database;
let purse: FakePurse;

beforeAll(async () => {
  database = testDatabase();
  await truncateAll(database);
  purse = fakePurse(database);
});

afterAll(async () => {
  await database.close();
});

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

describe('sign-in', () => {
  it('refuses the wrong office code and issues a session for the right one; the same name is the same player', async () => {
    const refused = await sessionPost(request('POST', '/api/session', { body: { name: 'Ada', officeCode: 'nope' } }));
    expect(refused.status).toBe(401);
    expect((await errorOf(refused)).code).toBe('office_code_incorrect');

    const first = await sessionPost(request('POST', '/api/session', { body: { name: 'Ada', officeCode: env().officeCode } }));
    expect(first.status).toBe(201);
    const created = await data<{ player: { id: string; name: string }; created: boolean }>(first);
    expect(created.created).toBe(true);
    expect(sessionCookie(first)).toMatch(/^pingpong_session=/);

    const again = await sessionPost(request('POST', '/api/session', { body: { name: '  ada ', officeCode: env().officeCode.toUpperCase() } }));
    expect(again.status).toBe(200);
    expect((await data<{ player: { id: string } }>(again)).player.id).toBe(created.player.id);

    const [row] = await database.db.select().from(players);
    expect(row?.purseExternalId).toMatch(/^pp-ppl_/);
  });
});

describe('a season, end to end', () => {
  it('walks from opening to settlement', async () => {
    await truncateAll(database);
    purse = fakePurse(database);
    const ada = await createPlayer(database, 'Ada');
    const grace = await createPlayer(database, 'Grace');
    const asAda = cookieFor(ada);
    const asGrace = cookieFor(grace);

    // Nothing on the board yet.
    expect(await data<{ season: null }>(await currentGet(request('GET', '/api/seasons/current', { cookie: asAda })))).toEqual({ season: null });

    // Ada opens the season: the Purse contest is created and opened, and she is the commissioner.
    const opened = await seasonsPost(request('POST', '/api/seasons', { cookie: asAda, body: { title: 'Autumn 2026' } }));
    expect(opened.status).toBe(201);
    const { season } = await data<{ season: SeasonView }>(opened);
    expect(season).toMatchObject({ status: 'enrolling', youAreCommissioner: true, youAreIn: false, purse: { contestState: 'open' } });
    const contestId = season.purse.contestId;
    if (contestId === null) throw new Error('no contest');
    expect(purse.contests.get(contestId)).toMatchObject({ state: 'open', kind: 'pool', entryAmount: 100n, prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] } });
    const second = await seasonsPost(request('POST', '/api/seasons', { cookie: asGrace, body: { title: 'Another' } }));
    expect((await errorOf(second)).code).toBe('season_already_open');

    // Both link: a Purse user each, the welcome points issued once.
    const linked = await data<{ linked: boolean; wallet: Array<{ asset: string; balance: string }> }>(await linkPost(request('POST', '/api/me/purse/link', { cookie: asAda })));
    expect(linked.linked).toBe(true);
    expect(linked.wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1000');
    await linkPost(request('POST', '/api/me/purse/link', { cookie: asAda }));
    await linkPost(request('POST', '/api/me/purse/link', { cookie: asGrace }));
    const adaPurse = purse.userByExternalId(ada.purseExternalId);
    const gracePurse = purse.userByExternalId(grace.purseExternalId);
    if (adaPurse === undefined || gracePurse === undefined) throw new Error('users not upserted');
    expect(purse.wallet(adaPurse.id)).toBe(1000n);

    // The entry happens in Purse's frame; the ladder reads it back. Nothing before the read-back.
    const empty = await data<{ added: number; season: SeasonView }>(await syncPost(request('POST', `/api/seasons/${season.id}/entries/sync`, { cookie: asAda }), params({ seasonId: season.id })));
    expect(empty).toMatchObject({ added: 0 });
    expect(empty.season.ladder).toEqual([]);
    await purse.enterUser(contestId, adaPurse.id);
    await purse.enterUser(contestId, gracePurse.id);
    const synced = await data<{ added: number; season: SeasonView }>(await syncPost(request('POST', `/api/seasons/${season.id}/entries/sync`, { cookie: asGrace }), params({ seasonId: season.id })));
    expect(synced.added).toBe(2);
    expect(synced.season.ladder.map((r) => [r.rank, r.player.name])).toEqual([
      [1, 'Ada'],
      [2, 'Grace'],
    ]);
    expect(synced.season.youAreIn).toBe(true);
    expect(purse.wallet(adaPurse.id)).toBe(900n);
    // A second read-back adds nobody.
    expect((await data<{ added: number }>(await syncPost(request('POST', `/api/seasons/${season.id}/entries/sync`, { cookie: asAda }), params({ seasonId: season.id })))).added).toBe(0);

    // Only the commissioner starts; the contest is locked and started.
    expect((await errorOf(await startPost(request('POST', `/api/seasons/${season.id}/start`, { cookie: asGrace }), params({ seasonId: season.id })))).code).toBe('commissioner_only');
    const { season: started } = await data<{ season: SeasonView }>(await startPost(request('POST', `/api/seasons/${season.id}/start`, { cookie: asAda }), params({ seasonId: season.id })));
    expect(started).toMatchObject({ status: 'playing', purse: { contestState: 'in_progress' } });
    expect(purse.contests.get(contestId)?.state).toBe('in_progress');

    // Grace (2) challenges Ada (1); Ada cannot challenge down; nobody can challenge while busy.
    expect((await errorOf(await challengePost(request('POST', `/api/seasons/${season.id}/challenges`, { cookie: asAda, body: { defenderId: grace.id } }), params({ seasonId: season.id })))).code).toBe('challenge_not_above');
    const challenged = await data<{ matchId: string; season: SeasonView }>(await challengePost(request('POST', `/api/seasons/${season.id}/challenges`, { cookie: asGrace, body: { defenderId: ada.id } }), params({ seasonId: season.id })));
    expect(challenged.season.matches[0]).toMatchObject({ status: 'challenged', yourTurn: 'report' });
    expect((await errorOf(await challengePost(request('POST', `/api/seasons/${season.id}/challenges`, { cookie: asGrace, body: { defenderId: ada.id } }), params({ seasonId: season.id })))).code).toBe('challenge_busy');
    const matchId = challenged.matchId;

    // Grace reports 11–7; she cannot confirm her own report; Ada confirms; the ladder reorders.
    expect((await errorOf(await reportPost(request('POST', `/api/matches/${matchId}/report`, { cookie: asGrace, body: { challengerScore: 11, defenderScore: 10 } }), params({ matchId })))).code).toBe('scoreline_invalid');
    const reported = await data<{ season: SeasonView }>(await reportPost(request('POST', `/api/matches/${matchId}/report`, { cookie: asGrace, body: { challengerScore: 11, defenderScore: 7 } }), params({ matchId })));
    expect(reported.season.matches[0]).toMatchObject({ status: 'reported', yourTurn: 'wait' });
    expect((await errorOf(await confirmPost(request('POST', `/api/matches/${matchId}/confirm`, { cookie: asGrace }), params({ matchId })))).code).toBe('confirm_other_side');
    const confirmed = await data<{ moved: boolean; push: { status: string }; season: SeasonView }>(await confirmPost(request('POST', `/api/matches/${matchId}/confirm`, { cookie: asAda }), params({ matchId })));
    expect(confirmed.moved).toBe(true);
    expect(confirmed.push).toEqual({ status: 'pushed', replayed: false });
    expect(confirmed.season.ladder.map((r) => [r.rank, r.player.name, r.wins, r.losses])).toEqual([
      [1, 'Grace', 1, 0],
      [2, 'Ada', 0, 1],
    ]);
    expect(confirmed.season.matches[0]).toMatchObject({ status: 'confirmed', ladderMoved: true, purse: { pushed: true, error: null } });
    // The running scores reached Purse under the match's key: Grace 1 win, Ada 0, neither finished.
    const pushed = purse.requestsTo(/\/scores$/, 'POST');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.idempotencyKey).toMatch(/^lmt_/);
    const contest = purse.contests.get(contestId);
    expect(contest?.scores.map((s) => [s.userId, s.score, s.attemptFinished])).toEqual(expect.arrayContaining([[gracePurse.id, 1, false], [adaPurse.id, 0, false]]));
    // Confirming again is not a second result.
    expect((await errorOf(await confirmPost(request('POST', `/api/matches/${matchId}/confirm`, { cookie: asAda }), params({ matchId })))).code).toBe('match_not_reported');

    // Close, step 1: only the commissioner; the final scores go over, the preview is frozen, play stops.
    expect((await errorOf(await previewPost(request('POST', `/api/seasons/${season.id}/close/preview`, { cookie: asGrace }), params({ seasonId: season.id })))).code).toBe('commissioner_only');
    const preview = await data<{ payoutHash: string; escrowTotal: string; payouts: Array<{ userId: string; placement: number; payout: string }>; season: SeasonView }>(await previewPost(request('POST', `/api/seasons/${season.id}/close/preview`, { cookie: asAda }), params({ seasonId: season.id })));
    expect(preview.escrowTotal).toBe('200');
    expect(preview.payouts).toEqual([
      { userId: gracePurse.id, placement: 1, payout: '125' },
      { userId: adaPurse.id, placement: 2, payout: '75' },
    ]);
    expect(preview.season).toMatchObject({ status: 'closing', purse: { contestState: 'awaiting_settlement' } });
    expect(preview.season.frozenPreview?.payoutHash).toBe(preview.payoutHash);
    expect(contest?.scores.filter((s) => !s.superseded).map((s) => [s.userId, s.score, s.attemptFinished])).toEqual(expect.arrayContaining([[gracePurse.id, 2, true], [adaPurse.id, 1, true]]));
    expect((await errorOf(await challengePost(request('POST', `/api/seasons/${season.id}/challenges`, { cookie: asAda, body: { defenderId: grace.id } }), params({ seasonId: season.id })))).code).toBe('season_not_playing');

    // Step 2: the wrong hash is refused; the right one settles, and the payouts land.
    const wrong = await closePost(request('POST', `/api/seasons/${season.id}/close`, { cookie: asAda, body: { payoutHash: 'f'.repeat(64) } }), params({ seasonId: season.id }));
    expect(wrong.status).toBe(409);
    expect((await errorOf(wrong)).code).toBe('preview_hash_mismatch');
    const closed = await data<{ replayed: boolean; results: Array<{ userId: string; placement: number; payoutAmount: string }>; season: SeasonView }>(await closePost(request('POST', `/api/seasons/${season.id}/close`, { cookie: asAda, body: { payoutHash: preview.payoutHash } }), params({ seasonId: season.id })));
    expect(closed.replayed).toBe(false);
    expect(closed.season).toMatchObject({ status: 'closed', purse: { contestState: 'settled' } });
    expect(closed.season.settlement?.results).toEqual([
      { userId: gracePurse.id, placement: 1, score: 2, payoutAmount: '125' },
      { userId: adaPurse.id, placement: 2, score: 1, payoutAmount: '75' },
    ]);
    expect(purse.wallet(gracePurse.id)).toBe(1025n);
    expect(purse.wallet(adaPurse.id)).toBe(975n);
    // Confirming the same hash again replays; nothing moves twice.
    const again = await data<{ replayed: boolean }>(await closePost(request('POST', `/api/seasons/${season.id}/close`, { cookie: asAda, body: { payoutHash: preview.payoutHash } }), params({ seasonId: season.id })));
    expect(again.replayed).toBe(true);
    expect(purse.wallet(gracePurse.id)).toBe(1025n);

    // The profile reads the wallet live, and the audit holds every call with no key in it.
    const profile = await data<{ linked: boolean; wallet: Array<{ asset: string; balance: string }> }>(await profileGet(request('GET', '/api/me/purse', { cookie: asGrace })));
    expect(profile.wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1025');
    const calls = await data<{ calls: Array<{ method: string; path: string; status: string; idempotencyKey: string | null }> }>(await callsGet(request('GET', '/api/purse-calls?limit=100', { cookie: asAda })));
    expect(calls.calls.length).toBeGreaterThan(10);
    expect(calls.calls.every((c) => c.status === 'succeeded' || c.status === 'refused')).toBe(true);
    expect(calls.calls.some((c) => c.method === 'POST' && c.path === `/v1/contests/${contestId}/close`)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(purse.secretKey);
    const [stored] = await database.sql`select request_body::text as body from purse_calls where path = '/v1/users' limit 1`;
    expect(stored?.['body']).not.toContain('sk_');

    // A closed season lets the next one open.
    const next = await seasonsPost(request('POST', '/api/seasons', { cookie: asGrace, body: { title: 'Winter 2026' } }));
    expect(next.status).toBe(201);
  });

  it('answers 503 purse_unavailable when no secret key is configured', async () => {
    await truncateAll(database);
    resetAppContext({ purse: null });
    const ada = await createPlayer(database, 'Ada');
    const response = await linkPost(request('POST', '/api/me/purse/link', { cookie: cookieFor(ada) }));
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('purse_unavailable');
  });

  it('requires a session', async () => {
    const response = await seasonsPost(request('POST', '/api/seasons', { body: { title: 'x' } }));
    expect(response.status).toBe(401);
  });
});
