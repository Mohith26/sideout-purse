import { count, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { charities } from '../db/schema';

/**
 * What the home screen knows about the state of play. Phase 0 has no tournaments table
 * yet, so "events" is honestly empty; the beneficiary count is the real query that proves
 * the page reaches the database.
 */
export type HomeSnapshot = {
  liveEvents: number;
  upcomingEvents: number;
  activeCharities: number;
};

export async function homeSnapshot(db: Db): Promise<HomeSnapshot> {
  const [row] = await db.select({ n: count() }).from(charities).where(eq(charities.status, 'active'));
  return {
    liveEvents: 0,
    upcomingEvents: 0,
    activeCharities: row?.n ?? 0,
  };
}
