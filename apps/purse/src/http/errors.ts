import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { API_ERROR_STATUS, type ApiError, type ApiErrorEnvelope, type ApiErrorType } from '@purse/types';
import { errorFields, type Logger } from '@repo/logger';

import { RulesetError } from '../eligibility/ruleset';
import { ProviderConfigError } from '../providers';
import { ApiFailure } from './envelope';

/**
 * Structured error mapping: every refusal a service can throw becomes one entry of the
 * sealed taxonomy (spec 4.7), and everything else is `internal_error` with nothing of the
 * cause in the body. The ledger, contest, identity and auth errors all carry the same
 * three fields (`apiType`, `code`, `detail`), so the mapping is by shape, not by class:
 * `insufficient_funds` from the ledger, `invalid_state` from a transition, `not_eligible`
 * from the evaluator with its reasons in `detail`, `conflict` from idempotency.
 */
type DomainError = Error & { apiType: ApiErrorType; code: string; detail: Record<string, unknown> };

function isDomainError(error: unknown): error is DomainError {
  return (
    error instanceof Error &&
    typeof (error as Partial<DomainError>).apiType === 'string' &&
    (API_ERROR_STATUS as Record<string, number>)[(error as DomainError).apiType] !== undefined &&
    typeof (error as Partial<DomainError>).code === 'string' &&
    typeof (error as Partial<DomainError>).detail === 'object'
  );
}

export type ValidationIssue = { path: string; message: string };

/**
 * A request that failed Zod validation. Zod 4's `ZodError` is deliberately not an `Error`,
 * and Hono rethrows anything that is not one past `onError`, so the routes throw this
 * instead (`parseBody`, `param`).
 */
export class RequestValidationError extends Error {
  override readonly name = 'RequestValidationError';
  readonly issues: ValidationIssue[];

  constructor(error: z.ZodError, prefix: readonly string[] = []) {
    const issues = error.issues.map((issue) => ({ path: [...prefix, ...issue.path.map(String)].join('.'), message: issue.message }));
    super(`Invalid request: ${issues.map((issue) => `${issue.path || '(body)'}: ${issue.message}`).join('; ')}`);
    this.issues = issues;
  }
}

export type MappedError = { error: ApiError; status: ContentfulStatusCode; unexpected: boolean };

export function toApiError(error: unknown): MappedError {
  if (error instanceof ApiFailure) {
    return { error: error.error, status: error.status ?? (API_ERROR_STATUS[error.error.type] as ContentfulStatusCode), unexpected: false };
  }
  if (isDomainError(error)) {
    // An internal error names its code and nothing of its cause; the log gets the rest.
    const detail = error.apiType === 'internal_error' ? {} : jsonSafe(error.detail);
    return {
      error: { type: error.apiType, code: error.code, message: error.message, ...(Object.keys(detail).length === 0 ? {} : { detail }) },
      status: API_ERROR_STATUS[error.apiType] as ContentfulStatusCode,
      unexpected: error.apiType === 'internal_error',
    };
  }
  if (error instanceof RequestValidationError) {
    return {
      error: { type: 'invalid_request', code: 'validation_failed', message: error.message, detail: { issues: error.issues } },
      status: 400,
      unexpected: false,
    };
  }
  if (error instanceof RulesetError) {
    return { error: { type: 'internal_error', code: 'ruleset_unavailable', message: 'No valid eligibility ruleset is active' }, status: 500, unexpected: true };
  }
  if (error instanceof ProviderConfigError) {
    return { error: { type: 'internal_error', code: 'provider_misconfigured', message: 'A provider seam is misconfigured' }, status: 500, unexpected: true };
  }
  return { error: { type: 'internal_error', code: 'unhandled', message: 'Something went wrong' }, status: 500, unexpected: true };
}

/** Render an error into the envelope, logging anything unexpected with its stack (never sent to the client). */
export function renderError(c: Context, logger: Logger, error: unknown): Response {
  const mapped = toApiError(error);
  if (mapped.unexpected) logger.error('unhandled error', errorFields(error));
  const body: ApiErrorEnvelope = { error: mapped.error };
  return c.json(body, mapped.status);
}

/** Bigints as decimal strings, dates as ISO strings, so a detail object is JSON. */
export function jsonSafe(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner)),
  ) as Record<string, unknown>;
}
