import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as challengePost } from '../../src/app/api/seasons/[seasonId]/challenges/route';
import { POST as closePost } from '../../src/app/api/seasons/[seasonId]/close/route';
import { POST as previewPost } from '../../src/app/api/seasons/[seasonId]/close/preview/route';
import { POST as syncPost } from '../../src/app/api/seasons/[seasonId]/entries/sync/route';
import { POST as startPost } from '../../src/app/api/seasons/[seasonId]/start/route';
import { POST as seasonsPost } from '../../src/app/api/seasons/route';
import { POST as confirmPost } from '../../src/app/api/matches/[matchId]/confirm/route';
import { POST as reportPost } from '../../src/app/api/matches/[matchId]/report/route';
import { POST as embedTokenPost } from '../../src/app/api/me/purse/embed-token/route';
import { POST as linkPost } from '../../src/app/api/me/purse/link/route';
import { GET as profileGet } from '../../src/app/api/me/purse/route';
import { players, purseCalls } from '../../src/db/schema';
import { loadEnv } from '../../src/env';
import { appContext, resetAppContext } from '../../src/server/context';
import type { SeasonView } from '../../src/server/seasons';
import { cookieFor, createPlayer, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';

/**
 * The walk across the real boundary, the way Sideout's `test/integration` does it: a Purse
 * API process (`PURSE_INTEGRATION_API_URL`) and the ping-pong tenant's seeded sandbox key
 * (`PINGPONG_INTEGRATION_SECRET_KEY`; named apart from the app's own variables so the rest
 * of the suite never reaches a live Purse), the route handlers called directly. Link two
 * players, open the season (a real contest), enter them (server to server, what the frame
 * does), start, a confirmed result pushed as running scores, the frozen preview, the
 * close, and the payouts read back from real wallets. Skipped when no Purse is configured;
 * CI starts one (`.github/workflows/ci.yml`), and docs/second-tenant.md says how to run it
 * locally.
 */
const API_URL = process.env['PURSE_INTEGRATION_API_URL'];
const SECRET_KEY = process.env['PINGPONG_INTEGRATION_SECRET_KEY'];
const PUBLISHABLE_KEY = process.env['PINGPONG_INTEGRATION_PUBLISHABLE_KEY'] ?? `pk_sandbox_${'x'.repeat(32)}`;
const configured = API_URL !== undefined && SECRET_KEY !== undefined;

describe.skipIf(!configured)('the ladder on a real Purse', () => {
  let database: Database;

  beforeAll(async () => {
    database = testDatabase();
    await truncateAll(database);
    resetAppContext({ env: loadEnv({ ...process.env, NODE_ENV: 'test', PURSE_API_URL: API_URL, PINGPONG_PURSE_SECRET_KEY: SECRET_KEY, NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: PUBLISHABLE_KEY }) });
  });
  afterAll(async () => {
    await database.close();
  });

  it('link → open → enter → start → confirmed result → preview → close → payouts', async () => {
    const client = appContext().purse;
    if (client === null) throw new Error('the Purse client was not built from the environment');
    const stamp = Date.now().toString(36);
    const ada = await createPlayer(database, `Ada ${stamp}`);
    const grace = await createPlayer(database, `Grace ${stamp}`);
    const asAda = cookieFor(ada);
    const asGrace = cookieFor(grace);

    // Link: real Purse users under the opaque external ids, the welcome points issued once.
    const linked = await data<{ linked: boolean; wallet: Array<{ asset: string; balance: string }> }>(await linkPost(request('POST', '/x', { cookie: asAda })));
    expect(linked.wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1000');
    await linkPost(request('POST', '/x', { cookie: asAda }));
    expect((await data<{ wallet: Array<{ asset: string; balance: string }> }>(await profileGet(request('GET', '/x', { cookie: asAda })))).wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1000');
    await linkPost(request('POST', '/x', { cookie: asGrace }));
    const [adaRow] = await database.db.select().from(players).where(eq(players.id, ada.id));
    const [graceRow] = await database.db.select().from(players).where(eq(players.id, grace.id));
    if (adaRow?.purseUserId === null || adaRow?.purseUserId === undefined || graceRow?.purseUserId === null || graceRow?.purseUserId === undefined) throw new Error('players not linked');

    // Open: a real contest, open for entries.
    const { season } = await data<{ season: SeasonView }>(await seasonsPost(request('POST', '/x', { cookie: asAda, body: { title: `Walk ${stamp}` } })));
    expect(season.purse.contestState).toBe('open');
    const contestId = season.purse.contestId;
    if (contestId === null) throw new Error('no contest');

    // An embed token for the entry flow mints against the real contest.
    const grant = await data<{ token: string; contestId: string | null }>(await embedTokenPost(request('POST', '/x', { cookie: asAda, body: { flow: 'entry', seasonId: season.id } })));
    expect(grant.token).toMatch(/^embt_/);
    expect(grant.contestId).toBe(contestId);

    // Enter, server to server (what the frame does), then read the entrants back onto the ladder.
    for (const [player, row] of [[ada, adaRow], [grace, graceRow]] as const) {
      const entered = await client.enterContest(contestId, { userId: row.purseUserId ?? '' }, { requestId: `it-${stamp}`, idempotencyKey: `it-${stamp}:enter:${player.id}`, subject: { type: 'player', id: player.id } });
      expect(entered.data.eligibility.allowed).toBe(true);
    }
    const synced = await data<{ added: number; season: SeasonView }>(await syncPost(request('POST', '/x', { cookie: asAda }), params({ seasonId: season.id })));
    expect(synced.added).toBe(2);
    expect(synced.season.ladder.map((r) => r.player.id)).toEqual([ada.id, grace.id]);

    // Start, challenge, report, confirm: the running scores reach the real contest.
    const { season: started } = await data<{ season: SeasonView }>(await startPost(request('POST', '/x', { cookie: asAda }), params({ seasonId: season.id })));
    expect(started.purse.contestState).toBe('in_progress');
    const { matchId } = await data<{ matchId: string }>(await challengePost(request('POST', '/x', { cookie: asGrace, body: { defenderId: ada.id } }), params({ seasonId: season.id })));
    await data(await reportPost(request('POST', '/x', { cookie: asGrace, body: { challengerScore: 11, defenderScore: 9 } }), params({ matchId })));
    const confirmed = await data<{ moved: boolean; push: { status: string; replayed?: boolean }; season: SeasonView }>(await confirmPost(request('POST', '/x', { cookie: asAda }), params({ matchId })));
    expect(confirmed.moved).toBe(true);
    expect(confirmed.push).toEqual({ status: 'pushed', replayed: false });
    expect(confirmed.season.ladder.map((r) => [r.player.id, r.wins])).toEqual([
      [grace.id, 1],
      [ada.id, 0],
    ]);
    const live = (await client.previewContest(contestId, { requestId: `it-${stamp}-peek` })).data;
    expect(live.entries.find((e) => e.userId === graceRow.purseUserId)).toMatchObject({ score: 1, attemptFinished: false });

    // The frozen preview: Purse's real settlement engine, 50/30 over 200 POINTS.
    const preview = await data<{ payoutHash: string; escrowTotal: string; payouts: Array<{ userId: string; placement: number; payout: string }> }>(await previewPost(request('POST', '/x', { cookie: asAda }), params({ seasonId: season.id })));
    expect(preview.escrowTotal).toBe('200');
    expect(preview.payouts).toEqual([
      { userId: graceRow.purseUserId, placement: 1, payout: '125' },
      { userId: adaRow.purseUserId, placement: 2, payout: '75' },
    ]);
    const stale = await closePost(request('POST', '/x', { cookie: asAda, body: { payoutHash: 'e'.repeat(64) } }), params({ seasonId: season.id }));
    expect((await errorOf(stale)).code).toBe('preview_hash_mismatch');

    // The close, and the payouts in real wallets; confirming again replays.
    const closed = await data<{ replayed: boolean; season: SeasonView }>(await closePost(request('POST', '/x', { cookie: asAda, body: { payoutHash: preview.payoutHash } }), params({ seasonId: season.id })));
    expect(closed.replayed).toBe(false);
    expect(closed.season).toMatchObject({ status: 'closed', purse: { contestState: 'settled' } });
    const again = await data<{ replayed: boolean }>(await closePost(request('POST', '/x', { cookie: asAda, body: { payoutHash: preview.payoutHash } }), params({ seasonId: season.id })));
    expect(again.replayed).toBe(true);
    expect((await data<{ wallet: Array<{ asset: string; balance: string }> }>(await profileGet(request('GET', '/x', { cookie: asGrace })))).wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1025');
    expect((await data<{ wallet: Array<{ asset: string; balance: string }> }>(await profileGet(request('GET', '/x', { cookie: asAda })))).wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('975');

    // Every call was recorded, none in flight, and the key never reached the table.
    const calls = await database.db.select().from(purseCalls);
    expect(calls.length).toBeGreaterThan(12);
    expect(calls.filter((c) => c.status === 'in_flight')).toHaveLength(0);
    expect(JSON.stringify(calls)).not.toContain(SECRET_KEY);
  });
});
