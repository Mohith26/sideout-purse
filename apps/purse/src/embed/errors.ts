import type { ApiErrorType } from '@purse/types';

/**
 * How the embed's own API refuses a request (spec 4.8). The token errors stay with
 * `AuthError` (`src/auth/errors.ts`); these are the session, origin and sign-in refusals.
 */
export const EMBED_ERROR_CODES = {
  publishable_key_required: 'authentication_error',
  origin_not_allowed: 'permission_error',
  session_required: 'authentication_error',
  invalid_code: 'authentication_error',
  code_expired: 'authentication_error',
  too_many_attempts: 'authentication_error',
  too_many_codes: 'rate_limited',
  sms_unavailable: 'internal_error',
  invalid_input: 'invalid_request',
  token_wrong_tenant: 'permission_error',
} as const satisfies Record<string, ApiErrorType>;

export type EmbedErrorCode = keyof typeof EMBED_ERROR_CODES;

export class EmbedError extends Error {
  override readonly name = 'EmbedError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: EmbedErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = EMBED_ERROR_CODES[code];
  }
}

export function isEmbedError(error: unknown, code?: EmbedErrorCode): error is EmbedError {
  return error instanceof EmbedError && (code === undefined || error.code === code);
}
