import type { SubmittedAttestation } from '../../domain/attestation';
import type { SubmittedSet } from '../../domain/consensus';
import type { ApiResult } from '../api-client';

/**
 * The score outbox (spec 5.3: a queued score submission that survives reload and syncs
 * on reconnect). A submission the phone cannot send is stored in IndexedDB exactly as it
 * would have gone over the wire, the same `POST /api/matches/:id/scores` body, and
 * replayed later through the same route, so the server treats it exactly like a live one:
 * same validation, same consensus path. Nothing is judged on the phone.
 *
 * Pure queue logic over a small store interface; `IndexedDbOutbox` is the browser store
 * and `MemoryOutbox` the one tests and non-IDB environments use. One queued item per
 * match: a newer submission from this phone replaces the older one, the way the server
 * supersedes a team's earlier row.
 *
 * A signed scoreline (spec section 12, item 1) is queued with its signature: the signature
 * was made over the scoreline, the match and the team, none of which the wait changes, so
 * the replay is still valid. A signature the server refuses when it arrives (the organizer
 * revoked the phone in the meantime, say) is a definitive refusal like any other: the item
 * is kept as `failed` with the server's words, never dropped.
 */
export type OutboxItem = {
  id: string;
  matchId: string;
  /** The route the body is posted to. */
  path: string;
  body: { sets: SubmittedSet[]; attestation?: SubmittedAttestation };
  createdAt: number;
  attempts: number;
  /** `queued` waits for the network; `failed` is a definitive server refusal kept for the player to read and discard. */
  status: 'queued' | 'failed';
  lastError: { code: string; message: string; at: number } | null;
};

export type OutboxStore = {
  list(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
};

export type OutboxSend = (item: OutboxItem) => Promise<ApiResult<unknown>>;

export type ReplayOutcome = { item: OutboxItem; result: 'sent' | 'failed' | 'settled_elsewhere' | 'deferred'; message: string | null };

export type ReplayReport = { outcomes: ReplayOutcome[]; /** A queued item is still waiting: the network did not answer. */ pending: boolean };

/** Refusals that mean the match no longer takes this submission: the item is dropped, not shown as a failure. */
const SETTLED_ELSEWHERE = new Set(['match_not_open', 'already_decided']);

export function scorePath(matchId: string): string {
  return `/api/matches/${encodeURIComponent(matchId)}/scores`;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueScore(store: OutboxStore, input: { matchId: string; sets: SubmittedSet[]; attestation?: SubmittedAttestation | null; now?: number }): Promise<OutboxItem> {
  const existing = (await store.list()).filter((i) => i.matchId === input.matchId);
  for (const stale of existing) await store.remove(stale.id);
  const item: OutboxItem = {
    id: newId(),
    matchId: input.matchId,
    path: scorePath(input.matchId),
    body: { sets: input.sets.map((s) => ({ ...s })), ...(input.attestation === undefined || input.attestation === null ? {} : { attestation: { ...input.attestation } }) },
    createdAt: input.now ?? Date.now(),
    attempts: 0,
    status: 'queued',
    lastError: null,
  };
  await store.put(item);
  return item;
}

export async function listQueued(store: OutboxStore): Promise<OutboxItem[]> {
  return (await store.list()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function discardOutbox(store: OutboxStore, id: string): Promise<void> {
  await store.remove(id);
}

/** A reply that says nothing about the submission: no connection, or a server that could not answer. Worth trying again later. */
export function isTransient(result: ApiResult<unknown>): boolean {
  if (result.ok) return false;
  return result.status === 0 || result.status >= 500 || result.status === 429;
}

/**
 * Send every queued item in order through `send`. A transient failure stops the run and
 * leaves the rest queued for the next reconnect; a definitive refusal marks that item
 * `failed` (or drops it when the match has since been settled) and moves on.
 */
export async function replayOutbox(store: OutboxStore, send: OutboxSend, now: () => number = Date.now): Promise<ReplayReport> {
  const outcomes: ReplayOutcome[] = [];
  const queued = (await listQueued(store)).filter((i) => i.status === 'queued');
  let pending = false;
  for (const item of queued) {
    if (pending) {
      outcomes.push({ item, result: 'deferred', message: null });
      continue;
    }
    let result: ApiResult<unknown>;
    try {
      result = await send(item);
    } catch (error) {
      result = { ok: false, error: { type: 'internal_error', code: 'unavailable', message: error instanceof Error ? error.message : 'Could not send.' }, status: 0, retryAfterMs: null };
    }
    if (result.ok) {
      await store.remove(item.id);
      outcomes.push({ item, result: 'sent', message: null });
      continue;
    }
    const at = now();
    if (isTransient(result)) {
      await store.put({ ...item, attempts: item.attempts + 1, lastError: { code: result.error.code, message: result.error.message, at } });
      outcomes.push({ item, result: 'deferred', message: result.error.message });
      pending = true;
      continue;
    }
    if (SETTLED_ELSEWHERE.has(result.error.code)) {
      await store.remove(item.id);
      outcomes.push({ item, result: 'settled_elsewhere', message: result.error.message });
      continue;
    }
    await store.put({ ...item, status: 'failed', attempts: item.attempts + 1, lastError: { code: result.error.code, message: result.error.message, at } });
    outcomes.push({ item, result: 'failed', message: result.error.message });
  }
  return { outcomes, pending };
}

// ---- Stores ---------------------------------------------------------------------------------

export class MemoryOutbox implements OutboxStore {
  private readonly items = new Map<string, OutboxItem>();
  async list(): Promise<OutboxItem[]> {
    await Promise.resolve();
    return [...this.items.values()].map((i) => structuredClone(i));
  }
  async put(item: OutboxItem): Promise<void> {
    await Promise.resolve();
    this.items.set(item.id, structuredClone(item));
  }
  async remove(id: string): Promise<void> {
    await Promise.resolve();
    this.items.delete(id);
  }
}

export const OUTBOX_DB = 'sideout-outbox';
const OUTBOX_STORE = 'items';
const OUTBOX_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** IndexedDB: survives a reload, a closed tab and a restarted browser. */
export class IndexedDbOutbox implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(OUTBOX_DB, OUTBOX_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open the outbox database'));
    });
    return this.db;
  }

  async list(): Promise<OutboxItem[]> {
    const db = await this.open();
    const tx = db.transaction(OUTBOX_STORE, 'readonly');
    const rows = await request(tx.objectStore(OUTBOX_STORE).getAll());
    await done(tx);
    return rows as OutboxItem[];
  }

  async put(item: OutboxItem): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).put(item);
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).delete(id);
    await done(tx);
  }
}

/** The store for this environment: IndexedDB in a browser that has it, memory otherwise (a private window that refuses it still gets a working queue for the session). */
export function createOutboxStore(): OutboxStore {
  if (typeof indexedDB !== 'undefined') return new IndexedDbOutbox(indexedDB);
  return new MemoryOutbox();
}
