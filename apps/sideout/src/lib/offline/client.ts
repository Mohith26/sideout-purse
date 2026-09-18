import type { SubmittedSet } from '../../domain/consensus';
import { api } from '../api-client';
import { createOutboxStore, discardOutbox, enqueueScore, listQueued, replayOutbox, type OutboxItem, type OutboxSend, type OutboxStore, type ReplayReport } from './outbox';

/**
 * The browser's one outbox: a lazily created store, subscribers that get the queue after
 * every change, and a single in-flight replay at a time. `OfflineStatus` (mounted once in
 * the shell) calls `syncOutbox` on load, on `online` and when the tab returns; the score
 * sheet calls `queueScore`; the match page subscribes to show what is waiting.
 */
let store: OutboxStore | null = null;
const listeners = new Set<(items: OutboxItem[]) => void>();
let syncing: Promise<ReplayReport> | null = null;

/** Fired on `window` after every replay with the report as `detail`, so a page can refresh what it shows. */
export const OUTBOX_REPLAYED_EVENT = 'sideout:outbox-replayed';

export function outboxStore(): OutboxStore {
  store ??= createOutboxStore();
  return store;
}

/** Test hook: swap the store (and forget any in-flight replay). */
export function useOutboxStoreForTests(next: OutboxStore | null): void {
  store = next;
  syncing = null;
}

async function broadcast(): Promise<void> {
  if (listeners.size === 0) return;
  const items = await listQueued(outboxStore());
  for (const listener of listeners) listener(items);
}

export function subscribeOutbox(listener: (items: OutboxItem[]) => void): () => void {
  listeners.add(listener);
  void listQueued(outboxStore()).then((items) => {
    if (listeners.has(listener)) listener(items);
  });
  return () => {
    listeners.delete(listener);
  };
}

export async function queueScore(matchId: string, sets: SubmittedSet[]): Promise<OutboxItem> {
  const item = await enqueueScore(outboxStore(), { matchId, sets });
  await broadcast();
  return item;
}

export async function discardQueued(id: string): Promise<void> {
  await discardOutbox(outboxStore(), id);
  await broadcast();
}

const sendThroughApi: OutboxSend = (item) => api(item.path, { method: 'POST', body: item.body });

/** Replay the queue through the real route; concurrent callers share the run. */
export function syncOutbox(send: OutboxSend = sendThroughApi): Promise<ReplayReport> {
  if (syncing !== null) return syncing;
  const run = replayOutbox(outboxStore(), send).finally(() => {
    syncing = null;
    void broadcast();
  });
  syncing = run;
  void run.then((report) => {
    if (typeof window !== 'undefined' && report.outcomes.length > 0) window.dispatchEvent(new CustomEvent(OUTBOX_REPLAYED_EVENT, { detail: report }));
  });
  return run;
}
