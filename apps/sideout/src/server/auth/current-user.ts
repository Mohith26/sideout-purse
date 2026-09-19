import { eq } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { users, type User } from '../../db/schema';
import { failure } from '../http/errors';
import { readSessionCookie, verifySession, type SessionVia } from './session';

export type SessionDeps = { db: Db; sessionSecret: string; now: Date };

/** The signed-in user and how the session was opened (`via` is `'demo'` for the public demo's picker, else null). */
export type CurrentSession = { user: User; via: SessionVia | null };

/** The session behind a request, or null when there is no valid session cookie (or its user is gone). */
export async function currentSession(request: Request, deps: SessionDeps): Promise<CurrentSession | null> {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token === null) return null;
  const session = verifySession(token, deps.sessionSecret, deps.now);
  if (session === null) return null;
  const [user] = await deps.db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  return user === undefined ? null : { user, via: session.via };
}

/** The signed-in user, or null when there is no valid session cookie. */
export async function currentUser(request: Request, deps: SessionDeps): Promise<User | null> {
  return (await currentSession(request, deps))?.user ?? null;
}

export async function requireUser(request: Request, deps: SessionDeps): Promise<User> {
  const user = await currentUser(request, deps);
  if (user === null) throw failure.authentication('sign_in_required', 'Sign in to do that.');
  return user;
}

/** Everything under `/api/admin/*` requires `users.role = organizer`. */
export async function requireOrganizer(request: Request, deps: SessionDeps): Promise<User> {
  const user = await requireUser(request, deps);
  if (user.role !== 'organizer') throw failure.permission('organizer_required', 'Only an organizer can do that.');
  return user;
}

/**
 * The session for a server component, which has no `Request`: the incoming `cookie`
 * header is read through `next/headers`. Null for a visitor.
 */
export async function pageSession(deps: SessionDeps): Promise<CurrentSession | null> {
  const { headers } = await import('next/headers');
  const cookie = (await headers()).get('cookie');
  return currentSession(new Request('http://sideout.local/', { headers: cookie === null ? {} : { cookie } }), deps);
}
