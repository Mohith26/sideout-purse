import type { Db } from '../../db/client';
import type { DbOrTx, Tx } from '../db';
import type { LiveEventInput } from './events';
import { publishLive } from './publish';

/**
 * The after-commit seam for live events (docs/live.md). A writer that changes something
 * a screen shows calls `emitLive` next to the write; the function that owns the
 * transaction opens it with `liveTransaction` instead of `db.transaction`, and the
 * queued events are published once, after the commit. A transaction that rolls back
 * publishes nothing, because the publish runs only when `db.transaction` has resolved.
 *
 * A writer that works on the pool rather than in a transaction (the Purse push moves a
 * consensus row statement by statement) is committed as each statement returns, so
 * `emitLive` on the pool publishes at once. A transaction handle that was not opened with
 * `liveTransaction` is a programming error and throws, rather than publishing before its
 * commit or dropping the event silently.
 */
const queues = new WeakMap<object, LiveEventInput[]>();

function isTransaction(handle: DbOrTx): handle is Tx {
  return 'rollback' in handle && typeof handle.rollback === 'function';
}

export async function liveTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const queued: LiveEventInput[] = [];
  const result = await db.transaction(async (tx) => {
    queues.set(tx, queued);
    try {
      return await work(tx);
    } finally {
      queues.delete(tx);
    }
  });
  // Here the transaction has committed; a throw above never reaches this line.
  if (queued.length > 0) await publishLive(db, queued);
  return result;
}

export async function emitLive(handle: DbOrTx, event: LiveEventInput): Promise<void> {
  const queue = queues.get(handle);
  if (queue !== undefined) {
    queue.push(event);
    return;
  }
  if (isTransaction(handle)) throw new Error('emitLive: the transaction was not opened with liveTransaction, so the event cannot be published after its commit');
  await publishLive(handle, [event]);
}
