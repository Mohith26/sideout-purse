import { eq, sql } from 'drizzle-orm';
import { newId } from '@repo/ids';

import { nameKeyOf } from '../domain/ladder';
import type { Db } from './client';
import { players, type Player } from './schema';

/**
 * The seed: four office regulars, so the ladder has people on the first screen, and
 * nothing else. Seasons are opened from the app (whoever opens one is its commissioner)
 * and entrants come from Purse, never from a seed row. Idempotent: rerunning finds the
 * players by name and changes nothing. `scripts/seed.ts` links them to Purse when a
 * secret key is configured.
 */
export const SEED_PLAYERS = ['Ada', 'Grace', 'Linus', 'Ken'] as const;

export async function seedPlayers(db: Db, now: Date): Promise<{ players: Player[]; created: number }> {
  const out: Player[] = [];
  let created = 0;
  for (const name of SEED_PLAYERS) {
    const nameKey = nameKeyOf(name);
    if (nameKey === null) throw new Error(`seed name ${name} has no key`);
    const [inserted] = await db
      .insert(players)
      .values({ id: newId('ppl'), name, nameKey, purseExternalId: `pp-${newId('ppl')}`, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: players.nameKey })
      .returning();
    if (inserted !== undefined) {
      created += 1;
      out.push(inserted);
      continue;
    }
    const [existing] = await db.select().from(players).where(eq(players.nameKey, nameKey));
    if (existing === undefined) throw new Error(`player ${name} neither inserted nor found`);
    out.push(existing);
  }
  return { players: out, created };
}

/** Every table the app writes, in foreign-key order; what the reset empties. */
export const APP_TABLES = ['purse_calls', 'ladder_matches', 'season_entries', 'seasons', 'players'] as const;

const RESETTABLE_DATABASE = /^pingpong(_demo.*|_test|_s\d+.*|_p\d+.*)?$/;

/** Empty every table (the demo reset, the e2e setup). Refuses a database whose name does not say it is a demo or test one. */
export async function clearAll(db: Db): Promise<{ database: string; deleted: Record<string, number> }> {
  const [row] = await db.execute<{ name: string }>(sql`select current_database()::text as name`);
  const name = row?.name ?? '';
  if (!RESETTABLE_DATABASE.test(name)) throw new Error(`Refusing to reset database "${name}": the reset only runs against pingpong, pingpong_demo* or a test database`);
  const deleted: Record<string, number> = {};
  await db.transaction(async (tx) => {
    for (const table of APP_TABLES) {
      const result = await tx.execute(sql.raw(`delete from public."${table}"`));
      deleted[table] = Number(result.count ?? 0);
    }
  });
  return { database: name, deleted };
}
