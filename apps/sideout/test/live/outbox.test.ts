import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { charities } from '../../src/db/schema';
import { logger } from '../../src/lib/logger';
import { closeLiveBus, LiveBus, liveBus, type LiveDelivery } from '../../src/server/live/bus';
import { emitLive, liveTransaction } from '../../src/server/live/outbox';
import { createCharity, testDatabase, truncateAll, type Database } from '../helpers';

/**
 * The after-commit seam (`server/live/outbox.ts`, docs/live.md): an event queued inside a
 * `liveTransaction` reaches a subscriber only after the transaction has committed, a
 * transaction that rolls back publishes nothing, a plain transaction handle is refused,
 * the pool publishes at once, and identical events in one transaction go out once.
 */
const TOURNAMENT = 'trn_01a0b16a-b475-74d4-b1cb-2dbdc0880001';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('live events and the transaction that owns them', () => {
  let database: Database;
  let received: LiveDelivery[];
  let unsubscribe: () => void;

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    received = [];
    unsubscribe = (await liveBus().subscribe({ kind: 'tournament', tournamentId: TOURNAMENT }, (delivery) => received.push(delivery), { address: 'test' })).unsubscribe;
  });
  afterEach(async () => {
    unsubscribe();
    await closeLiveBus();
  });
  afterAll(async () => {
    await database.close();
  });

  const events = () => received.flatMap((d) => (d.type === 'event' ? [d.event] : []));

  it('publishes after the commit, never before it', async () => {
    let seenInside: number | null = null;
    const charity = await liveTransaction(database.db, async (tx) => {
      const [row] = await tx.insert(charities).values({ id: 'chr_01a0b16a-b475-74d4-b1cb-2dbdc0880002', slug: 'inside', name: 'Inside' }).returning();
      await emitLive(tx, { tournamentId: TOURNAMENT, kind: 'state' });
      await emitLive(tx, { tournamentId: TOURNAMENT, kind: 'score', matchId: 'mch_01a0b16a-b475-74d4-b1cb-2dbdc0880003' });
      await settle(150);
      seenInside = received.length;
      return row;
    });
    expect(seenInside).toBe(0);
    expect(charity?.slug).toBe('inside');
    await settle(300);
    expect(events().map((e) => e.kind)).toEqual(['state', 'score']);
    expect(events().map((e) => e.seq)).toEqual([1, 2]);
    expect(await database.db.select().from(charities).where(eq(charities.slug, 'inside'))).toHaveLength(1);
  });

  it('publishes nothing for a transaction that rolls back', async () => {
    await expect(
      liveTransaction(database.db, async (tx) => {
        await tx.insert(charities).values({ id: 'chr_01a0b16a-b475-74d4-b1cb-2dbdc0880004', slug: 'rolled-back', name: 'Rolled back' });
        await emitLive(tx, { tournamentId: TOURNAMENT, kind: 'state' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await settle(300);
    expect(received).toEqual([]);
    expect(await database.db.select().from(charities).where(eq(charities.slug, 'rolled-back'))).toHaveLength(0);
  });

  it('refuses a transaction handle that was not opened for live events, and publishes at once on the pool', async () => {
    await expect(database.db.transaction((tx) => emitLive(tx, { tournamentId: TOURNAMENT, kind: 'state' }))).rejects.toThrow(/liveTransaction/);
    await settle(200);
    expect(received).toEqual([]);
    await emitLive(database.db, { tournamentId: TOURNAMENT, kind: 'standings', matchId: 'mch_01a0b16a-b475-74d4-b1cb-2dbdc0880005' });
    await settle(300);
    expect(events().map((e) => [e.kind, e.matchId])).toEqual([['standings', 'mch_01a0b16a-b475-74d4-b1cb-2dbdc0880005']]);
  });

  it('sends identical events of one transaction once and keeps distinct ones', async () => {
    await liveTransaction(database.db, async (tx) => {
      await createCharity(database, 'distinct');
      await emitLive(tx, { tournamentId: TOURNAMENT, kind: 'match', matchId: 'mch_01a0b16a-b475-74d4-b1cb-2dbdc0880006' });
      await emitLive(tx, { tournamentId: TOURNAMENT, kind: 'match', matchId: 'mch_01a0b16a-b475-74d4-b1cb-2dbdc0880006' });
      await emitLive(tx, { tournamentId: TOURNAMENT, kind: 'match', matchId: 'mch_01a0b16a-b475-74d4-b1cb-2dbdc0880007' });
      await emitLive(tx, { tournamentId: TOURNAMENT, kind: 'standings', matchId: 'mch_01a0b16a-b475-74d4-b1cb-2dbdc0880006' });
    });
    await settle(300);
    expect(events().map((e) => [e.kind, e.matchId?.slice(-1)])).toEqual([
      ['match', '6'],
      ['match', '7'],
      ['standings', '6'],
    ]);
  });

  it('ignores events of other tournaments on a tournament channel', async () => {
    await emitLive(database.db, { tournamentId: 'trn_01a0b16a-b475-74d4-b1cb-2dbdc0880008', kind: 'state' });
    await settle(300);
    expect(received).toEqual([]);
    expect(liveBus().listeningTo).toEqual([`sideout_live:${TOURNAMENT}`]);
  });

  it('keeps listening for the linger after the last subscriber leaves, then lets go, and an id from before cannot resume', async () => {
    const bus = new LiveBus({ sql: database.sql, log: logger('error'), lingerMs: 100, ringSize: 2 });
    try {
      const mine: LiveDelivery[] = [];
      const first = await bus.subscribe({ kind: 'tournament', tournamentId: TOURNAMENT }, (d) => mine.push(d), { address: 'a' });
      expect(bus.openStreams).toBe(1);
      expect(bus.streamsFrom('a')).toBe(1);
      await emitLive(database.db, { tournamentId: TOURNAMENT, kind: 'state' });
      await settle(300);
      const id = mine[0]?.type === 'event' ? mine[0].event.id : '';
      expect(id).toMatch(/-1$/);
      first.unsubscribe();
      expect(bus.openStreams).toBe(0);
      expect(bus.listeningTo).toHaveLength(1);

      // Back within the linger: the ring is intact and nothing newer exists.
      const back: LiveDelivery[] = [];
      const second = await bus.subscribe({ kind: 'tournament', tournamentId: TOURNAMENT }, (d) => back.push(d), { address: 'a', lastEventId: id });
      expect(back).toEqual([]);
      second.unsubscribe();

      await settle(250);
      expect(bus.listeningTo).toEqual([]);

      // After the linger the channel is new: the old id belongs to a gone epoch, so it resyncs.
      const later: LiveDelivery[] = [];
      const third = await bus.subscribe({ kind: 'tournament', tournamentId: TOURNAMENT }, (d) => later.push(d), { address: 'a', lastEventId: id });
      expect(later).toHaveLength(1);
      expect(later[0]?.type === 'signal' && later[0].signal.kind === 'resync').toBe(true);
      third.unsubscribe();
    } finally {
      await bus.close();
    }
  });

  it('evicts beyond the ring and resyncs an id the ring no longer covers', async () => {
    const bus = new LiveBus({ sql: database.sql, log: logger('error'), ringSize: 2 });
    try {
      const seen: LiveDelivery[] = [];
      const first = await bus.subscribe({ kind: 'tournament', tournamentId: TOURNAMENT }, (d) => seen.push(d), { address: 'a' });
      for (let i = 0; i < 4; i += 1) await emitLive(database.db, { tournamentId: TOURNAMENT, kind: 'match', matchId: `mch_01a0b16a-b475-74d4-b1cb-2dbdc088000${i}` });
      await settle(300);
      const ids = seen.flatMap((d) => (d.type === 'event' ? [d.event.id] : []));
      expect(ids).toHaveLength(4);
      first.unsubscribe();

      const fromSecond: LiveDelivery[] = [];
      const a = await bus.subscribe({ kind: 'tournament', tournamentId: TOURNAMENT }, (d) => fromSecond.push(d), { address: 'a', lastEventId: ids[1] });
      expect(fromSecond.map((d) => (d.type === 'event' ? d.event.id : d.signal.kind))).toEqual([ids[2], ids[3]]);
      a.unsubscribe();

      const fromFirst: LiveDelivery[] = [];
      const b = await bus.subscribe({ kind: 'tournament', tournamentId: TOURNAMENT }, (d) => fromFirst.push(d), { address: 'a', lastEventId: ids[0] });
      expect(fromFirst.map((d) => (d.type === 'event' ? d.event.id : d.signal.kind))).toEqual(['resync']);
      b.unsubscribe();
    } finally {
      await bus.close();
    }
  });
});
