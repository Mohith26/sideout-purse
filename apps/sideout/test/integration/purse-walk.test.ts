import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { asc, eq } from 'drizzle-orm';
import { WEBHOOK_SIGNATURE_HEADER } from '@purse/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as closePreview } from '../../src/app/api/admin/tournaments/[id]/close/preview/route';
import { POST as close } from '../../src/app/api/admin/tournaments/[id]/close/route';
import { POST as draw } from '../../src/app/api/admin/tournaments/[id]/draw/route';
import { GET as purseView } from '../../src/app/api/admin/tournaments/[id]/purse/route';
import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { POST as submitScores } from '../../src/app/api/matches/[id]/scores/route';
import { POST as embedToken } from '../../src/app/api/me/purse/embed-token/route';
import { POST as linkPurse } from '../../src/app/api/me/purse/link/route';
import { GET as purseProfile } from '../../src/app/api/me/purse/route';
import { POST as readBackEntries } from '../../src/app/api/teams/[id]/purse/entries/route';
import { POST as webhook } from '../../src/app/api/webhooks/purse/route';
import { matchConsensus, matches, purseCalls, purseWebhookEvents, teamMembers, tournaments, users, type Charity, type User } from '../../src/db/schema';
import { loadEnv } from '../../src/env';
import type { ConsensusView } from '../../src/server/consensus';
import { appContext, resetAppContext } from '../../src/server/context';
import type { ClosePreview } from '../../src/server/purse/close';
import { cookieFor, createCharity, createUser, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { registerTeams, tournamentBody } from '../api/fixtures';

/**
 * The walk across the real boundary: a Purse API process (`PURSE_INTEGRATION_API_URL`, the
 * seeded sandbox key in `PURSE_INTEGRATION_SECRET_KEY`; named apart from the app's own
 * variables so the rest of the suite never reaches a live Purse), Sideout's route handlers
 * called directly, and a loopback HTTP receiver Purse's dispatcher delivers webhooks to. Create the contest,
 * enter the players, agree the scores, preview, close, receive `contest.settled`, confirm.
 * Skipped when no Purse is configured; CI starts one (`.github/workflows/ci.yml`), and
 * `AGENTS.md` says how to run it locally.
 */
const API_URL = process.env['PURSE_INTEGRATION_API_URL'];
const SECRET_KEY = process.env['PURSE_INTEGRATION_SECRET_KEY'];
/** The SDK needs one to mount the flow; the server only hands it on, so a shaped stand-in serves when the seed's is not passed. */
const PUBLISHABLE_KEY = process.env['PURSE_INTEGRATION_PUBLISHABLE_KEY'] ?? `pk_sandbox_${'x'.repeat(32)}`;
const configured = API_URL !== undefined && SECRET_KEY !== undefined;

type SubmitResponse = { outcome: string; consensus: ConsensusView; match: { status: string; winnerTeamId: string | null }; purse: { status: string; error?: { code: string; message: string } } | null };

/** Forwards every delivery Purse makes to the webhook route handler, exactly as received, and keeps what it saw. */
class Receiver {
  private server: Server | undefined;
  readonly deliveries: Array<{ rawBody: string; signature: string | null; status: number }> = [];
  url = '';

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const signature = req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()];
        const header = typeof signature === 'string' ? signature : null;
        void webhook(request('POST', '/api/webhooks/purse', { body: rawBody, headers: { 'content-type': 'application/json', ...(header === null ? {} : { [WEBHOOK_SIGNATURE_HEADER]: header }) } })).then(async (response) => {
          this.deliveries.push({ rawBody, signature: header, status: response.status });
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(await response.text());
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/purse`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!configured)('Sideout on a real Purse', () => {
  let database: Database;
  let organizer: User;
  let charity: Charity;
  const receiver = new Receiver();
  let endpointId = '';

  beforeAll(async () => {
    database = testDatabase();
    await truncateAll(database);
    await receiver.start();
    // The app talks to the real Purse from the environment; the webhook secret is the endpoint's, minted here.
    resetAppContext({ env: loadEnv({ ...process.env, NODE_ENV: 'test', PURSE_API_URL: API_URL, SIDEOUT_PURSE_SECRET_KEY: SECRET_KEY, NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: PUBLISHABLE_KEY }) });
    const client = appContext().purse;
    if (client === null) throw new Error('the Purse client was not built from the environment');
    const endpoint = await client.createWebhookEndpoint(
      { url: receiver.url, subscribedEvents: ['contest.settled', 'contest.entry.created', 'contest.entry.withdrawn', 'user.verification.updated', 'wallet.balance.changed', 'contest.opened', 'contest.locked'], description: `sideout integration ${Date.now()}` },
      { requestId: `it-endpoint-${Date.now()}`, idempotencyKey: `it-endpoint-${Date.now()}-${Math.random()}` },
    );
    endpointId = endpoint.data.id;
    if (endpoint.data.secret === null) throw new Error('the endpoint secret was not returned');
    resetAppContext({ env: loadEnv({ ...process.env, NODE_ENV: 'test', PURSE_API_URL: API_URL, SIDEOUT_PURSE_SECRET_KEY: SECRET_KEY, NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, PURSE_WEBHOOK_SECRET: endpoint.data.secret }) });
    organizer = await createUser(database, { role: 'organizer' });
    charity = await createCharity(database);
  });
  afterAll(async () => {
    await receiver.stop();
    await database.close();
  });

  const organizerCookie = () => cookieFor(organizer);
  const patch = (id: string, body: Record<string, unknown>) => patchTournament(request('PATCH', '/x', { body, cookie: organizerCookie() }), params({ id }));
  const submit = (matchId: string, user: User, sets: Array<{ setNumber: number; usPoints: number; themPoints: number }>) =>
    submitScores(request('POST', '/x', { body: { sets }, cookie: cookieFor(user) }), params({ id: matchId }));
  const WIN = [{ setNumber: 1, usPoints: 21, themPoints: 18 }, { setNumber: 2, usPoints: 21, themPoints: 15 }];
  const LOSS = [{ setNumber: 1, usPoints: 18, themPoints: 21 }, { setNumber: 2, usPoints: 15, themPoints: 21 }];

  it('create contest → enter → agreed scores → preview → close → contest.settled webhook → confirmed', async () => {
    const client = appContext().purse;
    if (client === null) throw new Error('no Purse client');
    expect(endpointId).toMatch(/^whe_/);

    // A four-team single elimination: created, opened (the contest is created and opened in Purse).
    const { tournament } = await data<{ tournament: { id: string; slug: string } }>(
      await createTournament(request('POST', '/x', { body: tournamentBody(charity, { slug: `purse-walk-${Date.now()}`, format: 'single_elim', maxTeams: 4, entryDonationCents: '0' }), cookie: organizerCookie() })),
    );
    const opened = await data<{ purse: { status: string; contestId: string; contestState: string } }>(await patch(tournament.id, { status: 'registration_open' }));
    expect(opened.purse).toMatchObject({ status: 'mirrored', contestState: 'open' });
    const contestId = opened.purse.contestId;
    expect((await client.getContest(contestId, { requestId: 'it-read' })).data).toMatchObject({ state: 'open', asset: 'POINTS', entryAmount: '100', settlementPolicy: 'operator_close' });

    // Every player links (a Purse user by external id, welcome points) and enters through the contest's entries endpoint,
    // the same call the SDK's entry frame makes on the Purse origin; Sideout then reads the entrants back.
    const teamIds = await registerTeams(database, tournament.id, 4, { 0: 1, 1: 2, 2: 3, 3: 4 });
    const captains = new Map<string, User>();
    const players: User[] = [];
    for (const teamId of teamIds) {
      const members = await database.db.select({ member: teamMembers, user: users }).from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId)).where(eq(teamMembers.teamId, teamId)).orderBy(asc(teamMembers.createdAt));
      for (const { member, user } of members) {
        if (member.role === 'captain') captains.set(teamId, user);
        players.push(user);
        const linked = await data<{ linked: boolean; wallet: Array<{ asset: string; balance: string }> }>(await linkPurse(request('POST', '/x', { cookie: cookieFor(user) })));
        expect(linked.wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('1000');
        const [fresh] = await database.db.select().from(users).where(eq(users.id, user.id));
        if (fresh?.purseUserId === null || fresh?.purseUserId === undefined) throw new Error('not linked');
        const grant = await data<{ token: string; contestId: string | null; purseOrigin: string; tenantId: string }>(
          await embedToken(request('POST', '/x', { body: { flow: 'entry', tournamentSlug: tournament.slug }, cookie: cookieFor(user) })),
        );
        expect(grant.token).toMatch(/^embt_/);
        expect(grant.contestId).toBe(contestId);
        await client.enterContest(contestId, { userId: fresh.purseUserId, teamRef: teamId }, { requestId: `it-entry-${user.id}`, idempotencyKey: `it-entry-${user.id}` });
      }
    }
    for (const teamId of teamIds) {
      const captain = captains.get(teamId);
      if (captain === undefined) throw new Error('no captain');
      const entries = await data<{ complete: boolean; players: Array<{ entered: boolean }> }>(await readBackEntries(request('POST', '/x', { cookie: cookieFor(captain) }), params({ id: teamId })));
      expect(entries.complete).toBe(true);
    }
    expect((await client.getContest(contestId, { requestId: 'it-read' })).data).toMatchObject({ participantCount: 8, escrowBalance: '800' });
    const profile = await data<{ linked: boolean; wallet: Array<{ asset: string; balance: string }> }>(await purseProfile(request('GET', '/x', { cookie: cookieFor(players[0] ?? organizer) })));
    expect(profile.wallet.find((b) => b.asset === 'POINTS')?.balance).toBe('900');
    // Entries also arrived by webhook, deduped against the read-back on the Purse user id.
    await until(async () => ((await database.db.select().from(purseWebhookEvents)).filter((e) => e.eventType === 'contest.entry.created').length >= 8 ? true : undefined), 15_000, 'entry webhooks');
    const view = await data<{ reconciliation: { missing: unknown[]; extra: unknown[]; expected: unknown[] } }>(await purseView(request('GET', '/x', { cookie: organizerCookie() }), params({ id: tournament.id })));
    expect(view.reconciliation.expected).toHaveLength(8);
    expect(view.reconciliation.missing).toEqual([]);
    expect(view.reconciliation.extra).toEqual([]);

    // Registration closes, the bracket is drawn, the tournament goes live: the contest is locked and started.
    await data(await patch(tournament.id, { status: 'registration_closed' }));
    await data(await draw(request('POST', '/x', { body: { stage: 'bracket', courts: 2, rngSeed: 5 }, cookie: organizerCookie() }), params({ id: tournament.id })));
    const live = await data<{ purse: { status: string; contestState: string } }>(await patch(tournament.id, { status: 'live' }));
    expect(live.purse).toMatchObject({ status: 'mirrored', contestState: 'in_progress' });

    // Three matches agreed by both teams; each push is confirmed by Purse's idempotent replay.
    const cap = (teamId: string | null): User => {
      const u = teamId === null ? undefined : captains.get(teamId);
      if (u === undefined) throw new Error('no captain');
      return u;
    };
    const play = async (matchId: string): Promise<SubmitResponse> => {
      const [m] = await database.db.select().from(matches).where(eq(matches.id, matchId));
      if (m === undefined) throw new Error('no match');
      await data(await submit(m.id, cap(m.teamAId), WIN));
      const agreed = await data<SubmitResponse>(await submit(m.id, cap(m.teamBId), LOSS));
      expect(agreed.outcome).toBe('agreed');
      expect(agreed.purse).toEqual({ status: 'confirmed' });
      return agreed;
    };
    const rows = await database.db.select().from(matches).where(eq(matches.tournamentId, tournament.id)).orderBy(asc(matches.bracketPosition));
    const [m1, m2, final] = rows;
    if (m1 === undefined || m2 === undefined || final === undefined) throw new Error('bracket');
    await play(m1.id);
    await play(m2.id);
    const before = (await client.getContest(contestId, { requestId: 'it-read' })).data;
    const last = await play(final.id);
    expect(last.match.status).toBe('final');
    // The contract, on the Purse side: a replay under the consensus key created nothing new.
    const [consensus] = await database.db.select().from(matchConsensus).where(eq(matchConsensus.matchId, final.id));
    const calls = await database.db.select().from(purseCalls).where(eq(purseCalls.idempotencyKey, consensus?.idempotencyKey ?? '')).orderBy(asc(purseCalls.startedAt), asc(purseCalls.id));
    expect(calls.map((c) => [c.status, c.replayed, c.responseStatus])).toEqual([['succeeded', false, 201], ['succeeded', true, 201]]);
    const firstIds = ((calls[0]?.responseBody as { data: { scores: Array<{ id: string }> } }).data.scores.map((s) => s.id)).sort();
    const replayIds = ((calls[1]?.responseBody as { data: { scores: Array<{ id: string }> } }).data.scores.map((s) => s.id)).sort();
    expect(replayIds).toEqual(firstIds);
    const after = (await client.getContest(contestId, { requestId: 'it-read' })).data;
    expect(after.participantCount).toBe(before.participantCount);
    expect(after.escrowBalance).toBe(before.escrowBalance);

    // Awaiting settlement in Sideout: the final standings are pushed as finished attempts and Purse moves on by itself.
    const finished = await data<{ purse: { status: string; contestState: string } }>(await patch(tournament.id, { status: 'awaiting_settlement' }));
    expect(finished.purse.status).toBe('mirrored');
    const preview = await data<ClosePreview>(await closePreview(request('GET', '/x', { cookie: organizerCookie() }), params({ id: tournament.id })));
    expect(preview.contestState).toBe('awaiting_settlement');
    expect(preview.blockers).toEqual([]);
    expect(preview.standings.map((s) => s.placement)).toEqual([1, 2, 3, 3]);
    expect(preview.entries.every((e) => e.attemptFinished)).toBe(true);
    expect(preview.payouts.reduce((sum, p) => sum + BigInt(p.payout), 0n)).toBe(800n);
    // Purse's own preview agrees, hash for hash.
    expect((await client.previewContest(contestId, { requestId: 'it-read' })).data.payoutHash).toBe(preview.payoutHash);
    expect(await errorOf(await close(request('POST', '/x', { body: { payoutHash: 'a'.repeat(64) }, cookie: organizerCookie() }), params({ id: tournament.id })))).toMatchObject({ code: 'preview_hash_mismatch' });

    // The close: Purse settles behind the hash, the tournament is settled, the escrow is empty and the champions were paid.
    const closed = await data<{ status: string; settlement: { contestState: string; payoutHash: string; results: Array<{ userId: string; placement: number; payoutAmount: string }> } }>(
      await close(request('POST', '/x', { body: { payoutHash: preview.payoutHash }, cookie: organizerCookie() }), params({ id: tournament.id })),
    );
    expect(closed.status).toBe('settled');
    expect(closed.settlement.contestState).toBe('settled');
    expect(closed.settlement.payoutHash).toBe(preview.payoutHash);
    const settled = (await client.getContest(contestId, { requestId: 'it-read' })).data;
    expect(settled.state).toBe('settled');
    expect(settled.escrowBalance).toBe('0');
    const results = (await client.getResults(contestId, { requestId: 'it-read' })).data;
    expect(results.results.reduce((sum, r) => sum + BigInt(r.payoutAmount), 0n)).toBe(800n);
    const champions = preview.standings.find((s) => s.placement === 1)?.players.map((p) => p.purseUserId) ?? [];
    expect(results.results.filter((r) => r.placement === 1).map((r) => r.userId).sort()).toEqual([...champions].sort());

    // Purse's dispatcher delivers contest.settled to the receiver, signed; the receiver verifies, records, confirms.
    const settledEvent = await until(async () => (await database.db.select().from(purseWebhookEvents)).find((e) => e.eventType === 'contest.settled'), 20_000, 'the contest.settled webhook');
    expect(settledEvent.outcome).toMatch(/^applied/);
    const [tournamentRow] = await database.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    expect(tournamentRow?.status).toBe('settled');
    expect(tournamentRow?.purseContestState).toBe('settled');
    // A redelivery of the same bytes is a duplicate, applied no second time.
    const delivery = receiver.deliveries.find((d) => d.rawBody.includes('"contest.settled"'));
    if (delivery === undefined) throw new Error('the settled delivery was not captured');
    const again = await webhook(request('POST', '/api/webhooks/purse', { body: delivery.rawBody, headers: { 'content-type': 'application/json', ...(delivery.signature === null ? {} : { [WEBHOOK_SIGNATURE_HEADER]: delivery.signature }) } }));
    expect(await again.json()).toMatchObject({ data: { outcome: 'duplicate' } });
    expect((await database.db.select().from(purseWebhookEvents)).filter((e) => e.eventType === 'contest.settled')).toHaveLength(1);

    // Everything is in the audit of calls, and none of it carries the secret.
    const all = await database.db.select().from(purseCalls);
    expect(all.every((c) => c.status === 'succeeded' || c.status === 'refused')).toBe(true);
    expect(JSON.stringify(all)).not.toContain(SECRET_KEY ?? 'never');
    expect(all.some((c) => c.path.endsWith('/close') && c.status === 'succeeded')).toBe(true);
  }, 120_000);
});
