import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as allFeed } from '../../src/app/api/live/route';
import { GET as tournamentFeed } from '../../src/app/api/live/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import type { Charity, User } from '../../src/db/schema';
import { env } from '../../src/env';
import { resetAppContext } from '../../src/server/context';
import { closeLiveBus, liveBus } from '../../src/server/live/bus';
import { RETRY_HINT_MS } from '../../src/server/live/stream';
import { tournamentBody } from '../api/fixtures';
import { cookieFor, createCharity, createUser, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { liveTournament, submit, type LiveFixture } from './fixtures';
import { eventData, SseReader, type SseFrame } from './sse';

/**
 * `GET /api/live/tournaments/:id` and `GET /api/live` (docs/live.md): a stream opens with
 * the retry hint, carries an event once a score submission has committed, resumes from
 * `Last-Event-ID` out of the ring (and says `resync` when it cannot), heartbeats, closes
 * itself at its lifetime, and is refused with a 429 past the process and per-address caps.
 */
type Open = { response: Response; reader: SseReader; abort: () => void };

function withLive(overrides: Partial<ReturnType<typeof env>['live']>): void {
  const base = env();
  resetAppContext({ env: { ...base, live: { ...base.live, ...overrides } } });
}

async function open(path: string, headers: Record<string, string> = {}): Promise<Open> {
  const controller = new AbortController();
  const url = new URL(`http://sideout.test${path}`);
  const req = new Request(url, { headers, signal: controller.signal });
  const response = await (url.pathname === '/api/live' ? allFeed(req) : tournamentFeed(req, params({ id: url.pathname.split('/').pop() ?? '' })));
  return { response, reader: new SseReader(response), abort: () => controller.abort() };
}

async function expectConnected(o: Open): Promise<void> {
  expect(o.response.status).toBe(200);
  expect(o.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(o.response.headers.get('cache-control')).toBe('no-cache, no-transform');
  expect(o.response.headers.get('x-accel-buffering')).toBe('no');
  const first = await o.reader.next();
  expect(first?.retry).toBe(RETRY_HINT_MS);
  expect(first?.comments).toEqual(['connected']);
}

/** Read events until one of `kind` for `matchId` arrives; returns everything read. */
async function until(o: Open, kind: string, matchId: string | null, timeoutMs = 5_000): Promise<SseFrame[]> {
  const seen: SseFrame[] = [];
  for (;;) {
    const frame = await o.reader.nextEvent(timeoutMs);
    if (frame === null) throw new Error(`stream ended before a ${kind} event; saw ${JSON.stringify(seen)}`);
    seen.push(frame);
    if (frame.event !== undefined) continue;
    const body = eventData(frame);
    if (body.kind === kind && body.matchId === matchId) return seen;
  }
}

describe('the live streams', () => {
  let database: Database;
  let organizer: User;
  let charity: Charity;
  let live: LiveFixture;
  const opened: Open[] = [];

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    organizer = await createUser(database, { role: 'organizer' });
    charity = await createCharity(database);
    live = await liveTournament(database, organizer, charity);
  });
  afterEach(async () => {
    for (const o of opened.splice(0)) o.abort();
    await closeLiveBus();
  });
  afterAll(async () => {
    await database.close();
  });

  const track = async (path: string, headers: Record<string, string> = {}): Promise<Open> => {
    const o = await open(path, headers);
    opened.push(o);
    return o;
  };

  it('carries an event once a score submission has committed, on the tournament stream and the feed of every tournament', async () => {
    const stream = await track(`/api/live/tournaments/${live.id}`);
    const feed = await track('/api/live');
    await expectConnected(stream);
    await expectConnected(feed);
    const match = live.roundOne[0];
    if (match === undefined) throw new Error('no round-1 match');

    await data(await submit(match.id, live.captainOf(match.teamAId)));
    // The first submission records the reading (`score`), then takes the match on the sand and to awaiting scores (`match`, once: the two steps say the same thing).
    const frames = await until(stream, 'match', match.id);
    expect(frames.map((f) => eventData(f).kind)).toEqual(['score', 'match']);
    for (const frame of frames) {
      const body = eventData(frame);
      expect(body.tournamentId).toBe(live.id);
      expect(frame.id).toMatch(/^[A-Za-z0-9]+-\d+$/);
      expect(body.seq).toBeGreaterThan(0);
      expect(Object.keys(body).sort()).toEqual(['at', 'kind', 'matchId', 'seq', 'tournamentId']);
    }
    const seqs = frames.map((f) => eventData(f).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const onFeed = await until(feed, 'match', match.id);
    expect(onFeed.map((f) => eventData(f).tournamentId)).toContain(live.id);
  });

  it('resumes from Last-Event-ID out of the ring, replays nothing for a caller that is caught up, and resyncs an id it cannot resume', async () => {
    const first = await track(`/api/live/tournaments/${live.id}`);
    await expectConnected(first);
    const match = live.roundOne[0];
    if (match === undefined) throw new Error('no round-1 match');
    await data(await submit(match.id, live.captainOf(match.teamAId)));
    const frames = await until(first, 'match', match.id);
    const lastId = frames.at(-1)?.id ?? '';
    expect(lastId).not.toBe('');
    first.abort();

    // A reading replaced while nobody was connected: the ring kept it.
    await data(await submit(match.id, live.captainOf(match.teamAId), [{ setNumber: 1, usPoints: 21, themPoints: 12 }, { setNumber: 2, usPoints: 21, themPoints: 10 }]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const resumed = await track(`/api/live/tournaments/${live.id}`, { 'last-event-id': lastId });
    await expectConnected(resumed);
    const replayed = await resumed.reader.nextEvent();
    expect(replayed?.event).toBeUndefined();
    expect(eventData(replayed)).toMatchObject({ kind: 'score', matchId: match.id });
    expect(replayed?.id).not.toBe(lastId);
    const caughtUpId = replayed?.id ?? '';

    // Caught up: nothing is replayed, only the heartbeat follows.
    withLive({ heartbeatMs: 300 });
    const caughtUp = await track(`/api/live/tournaments/${live.id}?lastEventId=${encodeURIComponent(caughtUpId)}`);
    await expectConnected(caughtUp);
    const next = await caughtUp.reader.next(2_000);
    expect(next?.comments).toEqual(['heartbeat']);

    // An id from another epoch (another instance, or before a reconnect): one resync, carrying the current cursor.
    const stranger = await track(`/api/live/tournaments/${live.id}`, { 'last-event-id': 'zzzzzzzz-7' });
    await expectConnected(stranger);
    const resync = await stranger.reader.nextEvent();
    expect(resync?.event).toBe('resync');
    expect(resync?.id).toBe(caughtUpId);
  });

  it('heartbeats at the configured cadence and closes itself with bye at the end of its lifetime', async () => {
    withLive({ heartbeatMs: 150, streamTtlMs: 700 });
    const stream = await track(`/api/live/tournaments/${live.id}`);
    await expectConnected(stream);
    const started = Date.now();
    const a = await stream.reader.next(2_000);
    const b = await stream.reader.next(2_000);
    expect(a?.comments).toEqual(['heartbeat']);
    expect(b?.comments).toEqual(['heartbeat']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const bye = await stream.reader.nextEvent(3_000);
    expect(bye?.event).toBe('bye');
    expect(JSON.parse(bye?.data ?? '{}')).toEqual({ reason: 'ttl' });
    expect(await stream.reader.ends(2_000)).toBe(true);
    expect(liveBus().openStreams).toBe(0);
  });

  it('refuses with 429 and Retry-After past the process cap and the per-address cap, and frees the slot when a stream closes', async () => {
    withLive({ maxStreams: 2, maxStreamsPerAddress: 1 });
    const a = await track(`/api/live/tournaments/${live.id}`, { 'x-forwarded-for': '10.0.0.1' });
    await expectConnected(a);
    const sameAddress = await open(`/api/live/tournaments/${live.id}`, { 'x-forwarded-for': '10.0.0.1' });
    expect(sameAddress.response.status).toBe(429);
    expect(sameAddress.response.headers.get('retry-after')).toBe('5');
    expect(await errorOf(sameAddress.response)).toMatchObject({ type: 'rate_limited', code: 'live_too_many_streams' });

    const b = await track('/api/live', { 'x-forwarded-for': '10.0.0.2' });
    await expectConnected(b);
    const full = await open(`/api/live/tournaments/${live.id}`, { 'x-forwarded-for': '10.0.0.3' });
    expect(full.response.status).toBe(429);
    expect(await errorOf(full.response)).toMatchObject({ type: 'rate_limited', code: 'live_busy' });
    expect(liveBus().openStreams).toBe(2);

    // The client goes away: its slot is released.
    a.abort();
    expect(await a.reader.ends(2_000)).toBe(true);
    expect(liveBus().openStreams).toBe(1);
    const again = await track(`/api/live/tournaments/${live.id}`, { 'x-forwarded-for': '10.0.0.1' });
    await expectConnected(again);
  });

  it('is a 404 for an unknown tournament and for a draft, which is as invisible here as everywhere else', async () => {
    const missing = await open('/api/live/tournaments/trn_00000000-0000-7000-8000-000000000000');
    expect(missing.response.status).toBe(404);
    const { tournament } = await data<{ tournament: { id: string } }>(await createTournament(request('POST', '/x', { body: tournamentBody(charity, { slug: 'a-draft' }), cookie: cookieFor(organizer) })));
    const draft = await open(`/api/live/tournaments/${tournament.id}`);
    expect(draft.response.status).toBe(404);
    expect(await errorOf(draft.response)).toMatchObject({ type: 'not_found', code: 'tournament_not_found' });
  });
});
