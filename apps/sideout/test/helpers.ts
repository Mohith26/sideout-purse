import { newId } from '@repo/ids';

import { connect, type Database } from '../src/db/client';
import { charities, users, type Charity, type User } from '../src/db/schema';
import { env } from '../src/env';
import { mintPurseExternalId } from '../src/server/actor';
import { issueSession, sessionCookieHeader } from '../src/server/auth/session';
import { resetAppContext } from '../src/server/context';

export type { Database };

/**
 * Shared scaffolding for route tests. Every DB test file truncates the database before it
 * starts (the files run sequentially), signs users in by minting a real session cookie,
 * and calls the route handlers directly with `Request` objects, the same way Next does.
 */

export function testDatabase(): Database {
  return connect(env().databaseUrl, { max: 2 });
}

export async function truncateAll(database: Database): Promise<void> {
  await database.sql.unsafe(`
    truncate table
      audit_log, donation_provider_events, donations, sets, matches, pool_teams, pools,
      team_members, teams, sponsors, tournaments, auth_codes, users, charities
    restart identity cascade
  `);
  resetAppContext();
}

let phoneCounter = 200;

/** A fresh fictional phone number per call (`+1 415 555-02xx` and up). */
export function nextPhone(): string {
  phoneCounter += 1;
  return `+1415555${String(phoneCounter).padStart(4, '0')}`;
}

export async function createUser(database: Database, input: { role?: User['role']; displayName?: string; phone?: string } = {}): Promise<User> {
  const [user] = await database.db
    .insert(users)
    .values({
      id: newId('sou'),
      purseExternalId: mintPurseExternalId('user'),
      displayName: input.displayName ?? `Test ${input.role ?? 'player'} ${phoneCounter}`,
      phoneE164: input.phone ?? nextPhone(),
      role: input.role ?? 'player',
    })
    .returning();
  if (user === undefined) throw new Error('user insert returned no row');
  return user;
}

export async function createCharity(database: Database, slug = 'open-court-project'): Promise<Charity> {
  const [charity] = await database.db.insert(charities).values({ id: newId('chr'), slug, name: 'Open Court Project' }).returning();
  if (charity === undefined) throw new Error('charity insert returned no row');
  return charity;
}

/** A `Cookie` header value carrying a valid session for `user`. */
export function cookieFor(user: User, now = new Date()): string {
  const { token } = issueSession(user.id, env().sessionSecret, now);
  const header = sessionCookieHeader(token, { secure: false });
  return header.split(';')[0] ?? '';
}

export type JsonInit = { body?: unknown; cookie?: string | undefined; headers?: Record<string, string> | undefined };

export function request(method: string, path: string, init: JsonInit = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  return new Request(`http://sideout.test${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
}

export function params<P extends Record<string, string>>(value: P): { params: Promise<P> } {
  return { params: Promise.resolve(value) };
}

export type Envelope<T = unknown> = { data: T } | { error: { type: string; code: string; message: string; detail?: unknown } };

export async function json<T = unknown>(response: Response): Promise<Envelope<T>> {
  return (await response.json()) as Envelope<T>;
}

/** Unwrap `{ data }` or fail the test with the error envelope in the message. */
export async function data<T>(response: Response): Promise<T> {
  const body = await json<T>(response);
  if ('error' in body) throw new Error(`expected data, got ${response.status} ${JSON.stringify(body.error)}`);
  return body.data;
}

export async function errorOf(response: Response): Promise<{ type: string; code: string; message: string; detail?: unknown }> {
  const body = await json(response);
  if ('data' in body) throw new Error(`expected an error, got ${response.status} ${JSON.stringify(body.data)}`);
  return body.error;
}

/** Every key path in a JSON value, for asserting a projection omits something. */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [`${prefix}.${key}`, ...keyPaths(child, `${prefix}.${key}`)]);
  }
  return [];
}

export function expectNoPurseKeys(value: unknown): void {
  const offenders = keyPaths(value).filter((path) => /purse/i.test(path));
  if (offenders.length > 0) throw new Error(`public shape leaks Purse identifiers: ${offenders.join(', ')}`);
}
