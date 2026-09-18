import type { ApiErrorType } from '@purse/types';

/**
 * Every way the console's own authentication refuses a request (spec 4.10, "behind its
 * own auth"). Like the API key errors, `authentication_error` is "we do not know who you
 * are" and `permission_error` is "we do, and you may not". A wrong email and a wrong
 * password are one code, `invalid_credentials`, so a sign-in form cannot be used to learn
 * which emails are operators.
 */
export const OPERATOR_ERROR_CODES = {
  invalid_credentials: 'authentication_error',
  missing_session: 'authentication_error',
  session_invalid: 'authentication_error',
  session_expired: 'authentication_error',
  session_revoked: 'authentication_error',
  operator_disabled: 'permission_error',
  admin_required: 'permission_error',
  invalid_input: 'invalid_request',
  operator_not_found: 'invalid_request',
  email_taken: 'conflict',
} as const satisfies Record<string, ApiErrorType>;

export type OperatorErrorCode = keyof typeof OPERATOR_ERROR_CODES;

export class OperatorError extends Error {
  override readonly name = 'OperatorError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: OperatorErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = OPERATOR_ERROR_CODES[code];
  }
}

export function isOperatorError(error: unknown, code?: OperatorErrorCode): error is OperatorError {
  return error instanceof OperatorError && (code === undefined || error.code === code);
}
