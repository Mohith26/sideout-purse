import { count, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { charities } from '../db/schema';

/**
 * What the home screen knows about the state of play. Every figure on screen is derived
 * (spec section 7). The Home screen proper is phase 8; until then the beneficiary count is
 * the one figure, and it is the real query that proves the page reaches the database. The
 * events themselves are served by `/api/tournaments` (`server/tournaments.ts`).
 */
export type HomeSnapshot = {
  activeCharities: number;
};

export async function homeSnapshot(db: Db): Promise<HomeSnapshot> {
  const [row] = await db.select({ n: count() }).from(charities).where(eq(charities.status, 'active'));
  return { activeCharities: row?.n ?? 0 };
}
