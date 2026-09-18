import { REQUEST_ID_HEADER, type ApiDataEnvelope } from '@purse/types';
import { errorFields, type Logger } from '@repo/logger';
import { ZodError, z } from 'zod';

import { env } from '../../env';
import { logger } from '../../lib/logger';
import { readOrMintRequestId } from '../../lib/request-id';
import { ApiFailure, failure, type SideoutApiError } from './errors';

/**
 * The response envelope: `{ data }` on success, `{ error }` otherwise. Every route goes
 * through `handle`, so the shape, the request id echo and the error mapping cannot drift
 * between endpoints.
 */

type ResponseInitLike = { status?: number; headers?: Record<string, string> };

/**
 * JSON with `bigint` rendered as a decimal string. Services already project cents as
 * strings (`server/money.ts`); this is the guard that a stray `bigint` can never turn a
 * response into a 500.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

export function ok<T>(data: T, init: ResponseInitLike = {}): Response {
  const body: ApiDataEnvelope<T> = { data };
  return new Response(toJson(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function fail(error: SideoutApiError, status: number, init: ResponseInitLike = {}): Response {
  return new Response(toJson({ error }), {
    status,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export type RequestContext = {
  requestId: string;
  log: Logger;
};

/**
 * Run a route body with a request-scoped logger, echo the request id, and turn thrown
 * errors into the envelope: `ApiFailure` as-is, Zod failures as `invalid_request`, and
 * anything else as a logged `internal_error` that never leaks its message.
 */
export async function handle(request: Request, body: (context: RequestContext) => Promise<Response>): Promise<Response> {
  const requestId = readOrMintRequestId(request.headers.get(REQUEST_ID_HEADER));
  const log = logger(env().logLevel).child({ requestId });
  const method = request.method;
  const path = new URL(request.url).pathname;

  let response: Response;
  try {
    response = await body({ requestId, log });
  } catch (error) {
    response = renderError(error, log);
  }
  response.headers.set(REQUEST_ID_HEADER, requestId);
  log.info('request', { method, path, status: response.status });
  return response;
}

function renderError(error: unknown, log: Logger): Response {
  if (error instanceof ApiFailure) return fail(error.error, error.status);
  if (error instanceof ZodError) {
    const bad = failure.invalidRequest('validation_failed', 'The request did not match the expected shape.', z.treeifyError(error));
    return fail(bad.error, bad.status);
  }
  log.error('unhandled error', errorFields(error));
  const internal = failure.internal('unexpected', 'Something went wrong.');
  return fail(internal.error, internal.status);
}
