import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, type ApiError } from '@purse/types';

/**
 * The browser's calls, all to this origin's `/api/purse/*` proxy. Every mutation gets a
 * fresh `Idempotency-Key` per user action (a retry of the same action reuses it, so a
 * double click or a flaky network never performs a close twice), and a 401 sends the
 * operator to sign in again.
 */
export type ClientResult<T> = { ok: true; data: T; status: number; replayed: boolean } | { ok: false; error: ApiError; status: number };

export function newIdempotencyKey(): string {
  return `console-${globalThis.crypto.randomUUID()}`;
}

export async function consoleRequest<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<ClientResult<T>> {
  const headers = new Headers({ Accept: 'application/json' });
  const mutating = method !== 'GET';
  if (mutating) {
    headers.set('content-type', 'application/json');
    headers.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey ?? newIdempotencyKey());
  }
  let res: Response;
  try {
    res = await fetch(`/api/purse${path}`, { method, headers, ...(mutating ? { body: JSON.stringify(options.body ?? {}) } : {}), ...(options.signal === undefined ? {} : { signal: options.signal }), cache: 'no-store' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { ok: false, status: 0, error: { type: 'internal_error', code: 'network', message: 'The console could not reach its server' } };
  }
  const envelope = (await res.json().catch(() => ({}))) as { data?: T; error?: ApiError };
  if (res.status === 401 && typeof window !== 'undefined') {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  if (res.ok && envelope.data !== undefined) return { ok: true, data: envelope.data, status: res.status, replayed: res.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true' };
  return { ok: false, status: res.status, error: envelope.error ?? { type: 'internal_error', code: 'malformed_response', message: `Unexpected ${res.status} response` } };
}

export const api = {
  get: <T>(path: string, options?: { signal?: AbortSignal }) => consoleRequest<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => consoleRequest<T>('POST', path, { body, ...options }),
  patch: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => consoleRequest<T>('PATCH', path, { body, ...options }),
};
