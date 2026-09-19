import { timingSafeEqual } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../db/client';
import { players, type Player } from '../db/schema';
import { nameKeyOf } from '../domain/ladder';
import { failure } from './http/errors';

/**
 * Sign-in: a name and the shared office code. The code is the whole of the authentication
 * (this is an office ladder, docs/second-tenant.md); the name, normalised, is the
 * identity, so signing in again as "Ada" is the same player as "ada". A new name creates
 * the player and mints the opaque id Purse will know them by.
 */
export function officeCodeMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expected.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function signIn(db: Db, input: { name: string; officeCode: string; expectedOfficeCode: string; now: Date }): Promise<{ player: Player; created: boolean }> {
  if (!officeCodeMatches(input.officeCode, input.expectedOfficeCode)) throw failure.authentication('office_code_incorrect', 'That is not the office code.');
  const name = input.name.trim().replace(/\s+/g, ' ');
  const nameKey = nameKeyOf(name);
  if (nameKey === null || name.length > 40) throw failure.invalidRequest('name_invalid', 'Give a name of up to 40 letters or digits.');
  const [existing] = await db.select().from(players).where(eq(players.nameKey, nameKey));
  if (existing !== undefined) return { player: existing, created: false };
  const [created] = await db
    .insert(players)
    .values({ id: newId('ppl'), name, nameKey, purseExternalId: `pp-${newId('ppl')}`, createdAt: input.now, updatedAt: input.now })
    .onConflictDoNothing({ target: players.nameKey })
    .returning();
  if (created !== undefined) return { player: created, created: true };
  // Two first sign-ins for the same name raced; the other one won.
  const [raced] = await db.select().from(players).where(eq(players.nameKey, nameKey));
  if (raced === undefined) throw new Error('player neither inserted nor found');
  return { player: raced, created: false };
}

export async function loadPlayer(db: Db, playerId: string): Promise<Player> {
  const [player] = await db.select().from(players).where(eq(players.id, playerId));
  if (player === undefined) throw failure.notFound('player_not_found', 'No such player.');
  return player;
}

/** What a page or another player may see of a player: never the Purse ids. */
export type PublicPlayer = { id: string; name: string };

export function publicPlayer(player: Pick<Player, 'id' | 'name'>): PublicPlayer {
  return { id: player.id, name: player.name };
}
