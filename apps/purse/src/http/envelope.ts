import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { API_ERROR_STATUS, type ApiDataEnvelope, type ApiError, type ApiErrorEnvelope } from '@purse/types';

/**
 * The response envelope from spec 4.7: `{ data }` on success, `{ error }` otherwise. Every
 * route goes through these two helpers so the shape cannot drift between endpoints.
 */

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  const body: ApiDataEnvelope<T> = { data };
  return c.json(body, status);
}

export function fail(c: Context, error: ApiError, status?: ContentfulStatusCode) {
  const body: ApiErrorEnvelope = { error };
  return c.json(body, status ?? (API_ERROR_STATUS[error.type] as ContentfulStatusCode));
}

/** A thrown error that already knows its envelope. Routes throw it; `onError` renders it. */
export class ApiFailure extends Error {
  override readonly name = 'ApiFailure';
  constructor(
    readonly error: ApiError,
    readonly status?: ContentfulStatusCode,
  ) {
    super(error.message);
  }
}
