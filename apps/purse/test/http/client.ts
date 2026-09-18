import { IDEMPOTENCY_KEY_HEADER, type ApiError } from '@purse/types';
import { newId, type Id } from '@repo/ids';

import { createApiKey } from '../../src/auth';
import type { DbOrTx } from '../../src/db/client';
import { publishRuleset, SPEC_EXAMPLE_RULESET } from '../../src/eligibility';
import { openAccount } from '../../src/ledger';
import type { TestHarness } from '../helpers';
import { createTenant, key } from '../ledger/fixtures';

/**
 * HTTP test plumbing: a tenant with its platform accounts, the active ruleset and three
 * keys (an operator-scoped secret, a plain secret, a publishable), and a small client
 * that speaks the v1 conventions (bearer key, JSON body, `Idempotency-Key` on writes).
 */
export type Bootstrap = {
  tenantId: Id<'tnt'>;
  /** A secret key with the operator scope. */
  operatorKey: string;
  /** A secret key with no scope. */
  plainKey: string;
  publishableKey: string;
  keyIds: { operator: string; plain: string; publishable: string };
};

export async function bootstrapTenant(db: DbOrTx, options: { ruleset?: boolean } = {}): Promise<Bootstrap> {
  const tenantId = await createTenant(db);
  for (const asset of ['POINTS', 'CREDIT'] as const) {
    await openAccount(db, { tenantId, kind: 'promo_liability', ownerRef: null, asset });
  }
  if (options.ruleset !== false) await publishRuleset(db, { body: SPEC_EXAMPLE_RULESET, activate: true });
  const operator = await createApiKey(db, { tenantId, kind: 'secret', environment: 'sandbox', scopes: ['operator'], label: 'operator' });
  const plain = await createApiKey(db, { tenantId, kind: 'secret', environment: 'sandbox', label: 'plain' });
  const publishable = await createApiKey(db, { tenantId, kind: 'publishable', environment: 'sandbox', label: 'browser' });
  return {
    tenantId,
    operatorKey: operator.plaintext,
    plainKey: plain.plaintext,
    publishableKey: publishable.plaintext,
    keyIds: { operator: operator.key.id, plain: plain.key.id, publishable: publishable.key.id },
  };
}

export type ApiResponse<T = unknown> = {
  status: number;
  headers: Headers;
  data: T | undefined;
  error: ApiError | undefined;
  raw: unknown;
};

export type RequestOptions = {
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
  /** Send this exact text instead of a JSON body. */
  rawBody?: string;
};

export type Client = {
  get<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>>;
  delete<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>>;
  send<T = unknown>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>>;
};

/** A client bound to one key (or none). Writes get a fresh `Idempotency-Key` unless one is given, or `null` to send none. */
export function client(h: TestHarness, apiKey: string | undefined): Client {
  const send = async <T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> => {
    const headers: Record<string, string> = { ...options.headers };
    if (apiKey !== undefined) headers['Authorization'] = `Bearer ${apiKey}`;
    const write = method !== 'GET' && method !== 'HEAD';
    if (write && options.idempotencyKey !== null) headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey ?? key('http');
    let payload: string | undefined;
    if (options.rawBody !== undefined) {
      payload = options.rawBody;
      headers['content-type'] ??= 'application/json';
    } else if (body !== undefined) {
      payload = JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
      headers['content-type'] = 'application/json';
    }
    const res = await h.app.request(path, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    const text = await res.text();
    let raw: unknown = undefined;
    try {
      raw = text === '' ? undefined : JSON.parse(text);
    } catch {
      raw = text;
    }
    const envelope = (typeof raw === 'object' && raw !== null ? raw : {}) as { data?: T; error?: ApiError };
    return { status: res.status, headers: res.headers, data: envelope.data, error: envelope.error, raw };
  };
  return {
    send,
    get: (path, options) => send('GET', path, undefined, options),
    post: (path, body, options) => send('POST', path, body, options),
    delete: (path, body, options) => send('DELETE', path, body, options),
  };
}

/** A user the API knows nothing about yet: the id a partner would send by mistake. */
export function unknownUserId(): string {
  return newId('usr');
}
