import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { channelName, sameEvent, type LiveEventInput, type LivePayload } from './events';

/**
 * Publish live events through Postgres `NOTIFY` (docs/live.md): one row per event on the
 * tournament's channel and on the channel of every tournament, in a single statement.
 * The notification is what every process's bus (`bus.ts`) receives, this one included:
 * the in-process bus has no other input, so a screen served by any instance sees the
 * same events in the same order Postgres delivered them.
 *
 * Call this only once the writes an event describes are durable: `outbox.ts` runs it
 * after the owning transaction commits. A statement outside a transaction is committed
 * as it returns, so `pg_notify` is delivered at once.
 */
export async function publishLive(db: Db, events: readonly LiveEventInput[], now: Date = new Date()): Promise<void> {
  const distinct = events.filter((event, index) => events.findIndex((other) => sameEvent(other, event)) === index);
  if (distinct.length === 0) return;
  const at = now.toISOString();
  const rows = distinct.flatMap((event) => {
    const payload: LivePayload = { tournamentId: event.tournamentId, kind: event.kind, matchId: event.matchId ?? null, at };
    const text = JSON.stringify(payload);
    return [sql`(${channelName({ kind: 'tournament', tournamentId: event.tournamentId })}::text, ${text}::text)`, sql`(${channelName({ kind: 'all' })}::text, ${text}::text)`];
  });
  await db.execute(sql`select pg_notify(v.channel, v.payload) from (values ${sql.join(rows, sql`, `)}) as v(channel, payload)`);
}
