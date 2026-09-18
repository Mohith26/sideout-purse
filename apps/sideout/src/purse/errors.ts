import type { ApiError, ApiErrorType } from '@purse/types';

/**
 * How a Purse call fails, in three sealed shapes a caller can branch on:
 *
 * - `PurseApiError`: Purse answered with its error envelope (spec 4.7). `type` is Purse's
 *   sealed taxonomy and `code` its stable refinement; `detail` is whatever it carried (a
 *   `not_eligible` refusal's reasons, a hash mismatch's two digests).
 * - `PurseUnreachableError`: no answer at all (a refused connection, a timeout, a
 *   non-JSON body). The request may or may not have been performed; a retry under the
 *   same idempotency key is the only safe next step.
 * - `PurseResponseError`: a 2xx whose body did not match the resource schema. Purse
 *   changed under us; nothing is assumed about what happened.
 * - `PurseNotConfiguredError`: the process has no secret key, so nothing can be called.
 */
export class PurseApiError extends Error {
  override readonly name = 'PurseApiError';
  readonly type: ApiErrorType;
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;
  constructor(
    readonly status: number,
    error: ApiError,
    readonly requestId: string,
    /** From `Retry-After` on a 429, in milliseconds; null otherwise. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(error.message);
    this.type = error.type;
    this.code = error.code;
    this.detail = error.detail;
  }

  toJSON(): ApiError & { status: number } {
    return { status: this.status, type: this.type, code: this.code, message: this.message, ...(this.detail === undefined ? {} : { detail: this.detail }) };
  }
}

export class PurseUnreachableError extends Error {
  override readonly name = 'PurseUnreachableError';
  constructor(
    message: string,
    readonly requestId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class PurseResponseError extends Error {
  override readonly name = 'PurseResponseError';
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string,
  ) {
    super(message);
  }
}

export class PurseNotConfiguredError extends Error {
  override readonly name = 'PurseNotConfiguredError';
  constructor() {
    super('Purse is not configured: SIDEOUT_PURSE_SECRET_KEY is not set.');
  }
}

export type PurseFailure = PurseApiError | PurseUnreachableError | PurseResponseError | PurseNotConfiguredError;

export function isPurseFailure(error: unknown): error is PurseFailure {
  return error instanceof PurseApiError || error instanceof PurseUnreachableError || error instanceof PurseResponseError || error instanceof PurseNotConfiguredError;
}

/** A failure as a stored record: the shape `match_consensus.last_push_error` and audit rows keep. */
export function describeFailure(error: unknown, at: Date): { type: string; code: string; message: string; at: string } {
  if (error instanceof PurseApiError) return { type: error.type, code: error.code, message: error.message, at: at.toISOString() };
  if (error instanceof PurseUnreachableError) return { type: 'unreachable', code: 'purse_unreachable', message: error.message, at: at.toISOString() };
  if (error instanceof PurseResponseError) return { type: 'malformed_response', code: 'purse_response_invalid', message: error.message, at: at.toISOString() };
  if (error instanceof PurseNotConfiguredError) return { type: 'not_configured', code: 'purse_not_configured', message: error.message, at: at.toISOString() };
  return { type: 'unexpected', code: 'unexpected', message: error instanceof Error ? error.message : String(error), at: at.toISOString() };
}
