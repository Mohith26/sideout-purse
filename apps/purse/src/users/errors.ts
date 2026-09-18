import type { ApiErrorType } from '@purse/types';

/**
 * Every way the identity services refuse a request, with the sealed error type a route
 * reports it under (spec 4.7). Refusals, never bugs: anything unexpected propagates as-is.
 */
export const USERS_ERROR_CODES = {
  user_not_found: 'invalid_request',
  user_wrong_tenant: 'permission_error',
  invalid_input: 'invalid_request',
  // Verification (spec 4.1 state machine)
  verification_rejected: 'invalid_state',
  already_verified: 'invalid_state',
  provider_unavailable: 'internal_error',
  // Restrictions (spec 4.6)
  restriction_not_found: 'invalid_request',
  restriction_already_lifted: 'invalid_state',
  restriction_lift_forbidden: 'permission_error',
} as const satisfies Record<string, ApiErrorType>;

export type UsersErrorCode = keyof typeof USERS_ERROR_CODES;

export class UsersError extends Error {
  override readonly name = 'UsersError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: UsersErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = USERS_ERROR_CODES[code];
  }
}

export function isUsersError(error: unknown, code?: UsersErrorCode): error is UsersError {
  return error instanceof UsersError && (code === undefined || error.code === code);
}
