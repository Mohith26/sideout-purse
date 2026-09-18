import type { ApiErrorType } from '@purse/types';

/**
 * Every way authentication refuses a request: API keys (spec 4.1) and embed tokens
 * (spec 4.8). `authentication_error` is "we do not know who you are"; `permission_error`
 * is "we do, and you may not".
 */
export const AUTH_ERROR_CODES = {
  missing_api_key: 'authentication_error',
  invalid_api_key: 'authentication_error',
  api_key_revoked: 'authentication_error',
  secret_key_required: 'authentication_error',
  tenant_suspended: 'permission_error',
  operator_scope_required: 'permission_error',
  embed_token_invalid: 'authentication_error',
  embed_token_expired: 'authentication_error',
  embed_token_used: 'authentication_error',
  embed_token_wrong_flow: 'permission_error',
  invalid_input: 'invalid_request',
  api_key_not_found: 'invalid_request',
} as const satisfies Record<string, ApiErrorType>;

export type AuthErrorCode = keyof typeof AUTH_ERROR_CODES;

export class AuthError extends Error {
  override readonly name = 'AuthError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = AUTH_ERROR_CODES[code];
  }
}

export function isAuthError(error: unknown, code?: AuthErrorCode): error is AuthError {
  return error instanceof AuthError && (code === undefined || error.code === code);
}
