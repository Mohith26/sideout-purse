import type { ConsoleSessionResource } from '@purse/types';

import type { DbOrTx } from '../../src/db/client';
import type { OperatorRole } from '../../src/db/schema';
import { createOperator } from '../../src/operators';
import type { TestHarness } from '../helpers';
import { client, type Client } from '../http/client';

/**
 * Console test plumbing: operators created as the owner (the runtime cannot insert one),
 * a sign-in that returns the bearer token the console app would keep in its cookie, and a
 * client bound to that token which speaks the console's conventions (`Idempotency-Key` on
 * every write, JSON bodies).
 */
export const ADMIN_PASSWORD = 'correct-horse-battery-staple';
export const OPERATOR_PASSWORD = 'operator-password-of-length';

let counter = 0;

export async function makeOperator(db: DbOrTx, role: OperatorRole, options: { email?: string; password?: string } = {}) {
  counter += 1;
  const email = options.email ?? `${role}-${counter}-${Date.now()}@purse.test`;
  const password = options.password ?? (role === 'admin' ? ADMIN_PASSWORD : OPERATOR_PASSWORD);
  const operator = await createOperator(db, { email, password, role });
  return { operator, email, password };
}

export async function login(h: TestHarness, email: string, password: string, address?: string): Promise<ConsoleSessionResource> {
  const anonymous = client(h, undefined);
  const res = await anonymous.post<ConsoleSessionResource>('/console/auth/login', { email, password }, { idempotencyKey: null, ...(address === undefined ? {} : { address }) });
  if (res.status !== 201 || res.data === undefined) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.error)}`);
  return res.data;
}

/** A signed-in console client: an operator of `role` created as the owner and logged in through the API. */
export async function consoleClient(h: TestHarness, owner: DbOrTx, role: OperatorRole = 'admin'): Promise<{ api: Client; session: ConsoleSessionResource; email: string; password: string }> {
  const { email, password } = await makeOperator(owner, role);
  const session = await login(h, email, password);
  return { api: client(h, session.token), session, email, password };
}
