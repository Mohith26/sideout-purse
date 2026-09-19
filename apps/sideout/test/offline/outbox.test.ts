import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { ApiResult } from '../../src/lib/api-client';
import { enqueueScore, IndexedDbOutbox, isTransient, listQueued, MemoryOutbox, replayOutbox, scorePath, type OutboxItem, type OutboxStore } from '../../src/lib/offline/outbox';

/**
 * The score outbox (spec 5.3: a queued submission that survives reload and syncs on
 * reconnect): one item per match, the same wire body the live route takes, transient
 * failures deferred and definitive refusals kept for the player to read.
 */
const SETS = [
  { setNumber: 1, usPoints: 21, themPoints: 18 },
  { setNumber: 2, usPoints: 21, themPoints: 16 },
];

const ok = (): ApiResult<unknown> => ({ ok: true, data: { outcome: 'awaiting_second' }, status: 201, retryAfterMs: null });
const transport = (): ApiResult<unknown> => ({ ok: false, error: { type: 'internal_error', code: 'unavailable', message: 'Could not reach Sideout.' }, status: 0, retryAfterMs: null });
const refused = (code: string, message: string, status = 409): ApiResult<unknown> => ({ ok: false, error: { type: 'invalid_state', code, message }, status, retryAfterMs: null });

async function seeded(store: OutboxStore): Promise<OutboxItem[]> {
  const a = await enqueueScore(store, { matchId: 'm1', sets: SETS, now: 1000 });
  const b = await enqueueScore(store, { matchId: 'm2', sets: SETS, now: 2000 });
  return [a, b];
}

describe('outbox queue', () => {
  it('queues the exact wire body under the match route, one item per match, newest replacing older', async () => {
    const store = new MemoryOutbox();
    const first = await enqueueScore(store, { matchId: 'm1', sets: SETS, now: 1000 });
    expect(first.path).toBe(scorePath('m1'));
    expect(first.body).toEqual({ sets: SETS });
    expect(first.status).toBe('queued');
    const second = await enqueueScore(store, { matchId: 'm1', sets: [SETS[0]!], now: 2000 });
    const queued = await listQueued(store);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.id).toBe(second.id);
    expect(queued[0]?.body.sets).toHaveLength(1);
  });

  it('queues a signed scoreline with its signature, and keeps a refused signature as failed rather than dropping it', async () => {
    const store = new MemoryOutbox();
    const attestation = { keyId: 'k'.repeat(43), algorithm: 'ES256' as const, signature: 's'.repeat(86), timestamp: '2026-09-19T16:05:00.000Z' };
    const item = await enqueueScore(store, { matchId: 'm1', sets: SETS, attestation, now: 1000 });
    expect(item.body).toEqual({ sets: SETS, attestation });
    const unsigned = await enqueueScore(store, { matchId: 'm2', sets: SETS, attestation: null, now: 2000 });
    expect('attestation' in unsigned.body).toBe(false);
    const send = vi.fn(async (sent: OutboxItem): Promise<ApiResult<unknown>> => {
      await Promise.resolve();
      if (sent.matchId === 'm1') return { ok: false, error: { type: 'invalid_attestation', code: 'device_revoked', message: 'The organizer revoked this phone’s check-in.' }, status: 422, retryAfterMs: null };
      return ok();
    });
    const report = await replayOutbox(store, send, () => 5000);
    expect(report.outcomes.map((o) => [o.item.matchId, o.result])).toEqual([
      ['m1', 'failed'],
      ['m2', 'sent'],
    ]);
    expect(send.mock.calls[0]?.[0]?.body).toEqual({ sets: SETS, attestation });
    const left = await listQueued(store);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ matchId: 'm1', status: 'failed', lastError: { code: 'device_revoked', message: 'The organizer revoked this phone’s check-in.', at: 5000 } });
  });

  it('classifies no answer, 5xx and 429 as transient; a 4xx refusal is definitive', () => {
    expect(isTransient(transport())).toBe(true);
    expect(isTransient({ ok: false, error: { type: 'internal_error', code: 'x', message: 'x' }, status: 503, retryAfterMs: null })).toBe(true);
    expect(isTransient({ ok: false, error: { type: 'rate_limited', code: 'x', message: 'x' }, status: 429, retryAfterMs: 1000 })).toBe(true);
    expect(isTransient(refused('illegal_scoreline', 'no', 400))).toBe(false);
    expect(isTransient(ok())).toBe(false);
  });

  it('replays in order through the same route, removing what was sent', async () => {
    const store = new MemoryOutbox();
    const [a, b] = await seeded(store);
    const send = vi.fn().mockResolvedValue(ok());
    const report = await replayOutbox(store, send);
    expect(send.mock.calls.map((c) => (c[0] as OutboxItem).matchId)).toEqual(['m1', 'm2']);
    expect(report.outcomes.map((o) => o.result)).toEqual(['sent', 'sent']);
    expect(report.pending).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(a!.id).not.toBe(b!.id);
  });

  it('a transient failure stops the run, keeps everything queued and counts the attempt', async () => {
    const store = new MemoryOutbox();
    await seeded(store);
    const send = vi.fn().mockResolvedValueOnce(transport());
    const report = await replayOutbox(store, send, () => 5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(report.outcomes.map((o) => o.result)).toEqual(['deferred', 'deferred']);
    expect(report.pending).toBe(true);
    const [first] = await listQueued(store);
    expect(first?.attempts).toBe(1);
    expect(first?.lastError).toEqual({ code: 'unavailable', message: 'Could not reach Sideout.', at: 5000 });
    expect(first?.status).toBe('queued');
  });

  it('a definitive refusal is kept as failed for the player; a match settled elsewhere is dropped', async () => {
    const store = new MemoryOutbox();
    await seeded(store);
    const send = vi.fn().mockResolvedValueOnce(refused('illegal_scoreline', 'Set 1 is not finished.', 400)).mockResolvedValueOnce(refused('already_decided', 'Both teams have already confirmed this result; it is final.'));
    const report = await replayOutbox(store, send);
    expect(report.outcomes.map((o) => o.result)).toEqual(['failed', 'settled_elsewhere']);
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ matchId: 'm1', status: 'failed', lastError: { code: 'illegal_scoreline' } });
    // A failed item is not retried on the next run.
    const again = await replayOutbox(store, vi.fn().mockResolvedValue(ok()));
    expect(again.outcomes).toEqual([]);
  });

  it('a throwing sender counts as transient', async () => {
    const store = new MemoryOutbox();
    await seeded(store);
    const report = await replayOutbox(store, vi.fn().mockRejectedValue(new Error('boom')));
    expect(report.outcomes[0]).toMatchObject({ result: 'deferred', message: 'boom' });
    expect(report.pending).toBe(true);
  });
});

describe('IndexedDbOutbox', () => {
  it('persists items across store instances on the same database, the way a reload finds them', async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbOutbox(factory);
    const item = await enqueueScore(first, { matchId: 'm9', sets: SETS, now: 42 });
    const second = new IndexedDbOutbox(factory);
    const found = await listQueued(second);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(item);
    await second.remove(item.id);
    expect(await first.list()).toEqual([]);
  });
});
