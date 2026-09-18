import { act, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import type { ApiError } from '@purse/types';

/**
 * A scripted `fetch` for the console's `/api/purse/*` calls: each handler answers by
 * method and path, and every call is recorded so a test can assert what was sent (the
 * hash a close posted, the idempotency key it reused).
 */
export type Recorded = { method: string; path: string; body: unknown; headers: Record<string, string> };

export type Handler = (call: Recorded) => { status: number; data?: unknown; error?: ApiError; headers?: Record<string, string> };

export function mockApi(handlers: Record<string, Handler>): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.replace(/^\/api\/purse/, '');
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const body = typeof init?.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as unknown) : undefined;
      const call: Recorded = { method, path, body, headers };
      calls.push(call);
      const key = `${method} ${path.split('?')[0] ?? ''}`;
      const handler = handlers[key];
      if (handler === undefined) {
        return new Response(JSON.stringify({ error: { type: 'invalid_request', code: 'not_found', message: `unmocked ${key}` } }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      const answer = handler(call);
      const payload = answer.error === undefined ? { data: answer.data } : { error: answer.error };
      await Promise.resolve();
      return new Response(JSON.stringify(payload), { status: answer.status, headers: { 'content-type': 'application/json', ...answer.headers } });
    }),
  );
  return { calls };
}

/** Click and let the handlers and state updates settle. */
export async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}
