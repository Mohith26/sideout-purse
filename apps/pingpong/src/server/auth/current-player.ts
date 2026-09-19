import { eq } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { players, type Player } from '../../db/schema';
import { failure } from '../http/errors';
import { readSessionCookie, verifySession } from './session';

export type SessionDeps = { db: Db; sessionSecret: string; now: Date };

/** The signed-in player, or null when there is no valid session cookie. */
export async function currentPlayer(request: Request, deps: SessionDeps): Promise<Player | null> {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token === null) return null;
  const session = verifySession(token, deps.sessionSecret, deps.now);
  if (session === null) return null;
  const [player] = await deps.db.select().from(players).where(eq(players.id, session.playerId)).limit(1);
  return player ?? null;
}

export async function requirePlayer(request: Request, deps: SessionDeps): Promise<Player> {
  const player = await currentPlayer(request, deps);
  if (player === null) throw failure.authentication('sign_in_required', 'Sign in to do that.');
  return player;
}

/** The signed-in player for a server component, which has no `Request`: the incoming `cookie` header is read through `next/headers`. */
export async function pagePlayer(deps: SessionDeps): Promise<Player | null> {
  const { headers } = await import('next/headers');
  const cookie = (await headers()).get('cookie');
  return currentPlayer(new Request('http://pingpong.local/', { headers: cookie === null ? {} : { cookie } }), deps);
}
