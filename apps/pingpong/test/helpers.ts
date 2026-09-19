import { newId } from '@repo/ids';

import { connect, type Database } from '../src/db/client';
import { players, type Player } from '../src/db/schema';
import { nameKeyOf } from '../src/domain/ladder';
import { env } from '../src/env';
import { issueSession, sessionCookieHeader } from '../src/server/auth/session';
import { resetAppContext } from '../src/server/context';
import { databaseCallRecorder, PurseClient } from '../src/purse';
import { FakePurse } from './purse/fake-purse';

export type { Database };

/**
 * Shared scaffolding for the route tests: every database test file truncates the database
 * before it starts (the files run sequentially), signs players in by minting a real
 * session cookie, and calls the route handlers directly with `Request` objects, the same
 * way Next does. Purse is the in-memory fake behind the client's `fetch`.
 */
export function testDatabase(): Database {
  return connect(env().databaseUrl, { max: 2 });
}

export async function truncateAll(database: Database): Promise<void> {
  await database.sql.unsafe('truncate table purse_calls, ladder_matches, season_entries, seasons, players restart identity cascade');
  resetAppContext();
}

/** An in-memory Purse wired into the app context, its calls recorded in `purse_calls` like the real one's. */
export function fakePurse(database: Database): FakePurse {
  const fake = new FakePurse();
  resetAppContext({
    purse: new PurseClient({ baseUrl: 'http://purse.test', secretKey: fake.secretKey, fetch: fake.fetch, sleep: () => Promise.resolve(), recorder: databaseCallRecorder(database.db) }),
  });
  return fake;
}

let counter = 0;

export async function createPlayer(database: Database, name?: string): Promise<Player> {
  counter += 1;
  const chosen = name ?? `Player ${counter}`;
  const nameKey = nameKeyOf(chosen);
  if (nameKey === null) throw new Error('bad name');
  const [player] = await database.db
    .insert(players)
    .values({ id: newId('ppl'), name: chosen, nameKey, purseExternalId: `pp-${newId('ppl')}` })
    .returning();
  if (player === undefined) throw new Error('player insert returned no row');
  return player;
}

/** A `Cookie` header value carrying a valid session for `player`. */
export function cookieFor(player: Player, now = new Date()): string {
  const { token } = issueSession(player.id, env().sessionSecret, now);
  return sessionCookieHeader(token, { secure: false }).split(';')[0] ?? '';
}

export type JsonInit = { body?: unknown; cookie?: string | undefined; headers?: Record<string, string> | undefined };

export function request(method: string, path: string, init: JsonInit = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  return new Request(`http://pingpong.test${path}`, { method, headers, ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }) });
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
