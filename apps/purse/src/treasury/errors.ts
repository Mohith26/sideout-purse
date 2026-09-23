import type { ApiErrorType } from '@purse/types';

/**
 * Every way the treasury refuses a request (spec 13.4). Same discipline as the ledger's
 * and the contest engine's: the `code` is stable and machine-readable, the `apiType` is
 * the sealed error type a route reports it under, and a refusal is never a bug.
 */
export const TREASURY_ERROR_CODES = {
  // Instruments
  instrument_not_supported: 'invalid_request',
  payment_method_not_found: 'invalid_request',
  payment_method_inactive: 'invalid_state',
  payment_method_wrong_owner: 'permission_error',
  // Amounts and limits
  amount_below_minimum: 'invalid_request',
  amount_above_maximum: 'invalid_request',
  invalid_amount: 'invalid_request',
  // The rail
  rail_declined: 'invalid_state',
  // Eligibility and policy. A user who may not move money is `not_eligible`, the same
  // sealed type a refused contest entry uses, so a partner branches on one thing.
  verification_required: 'not_eligible',
  user_restricted: 'not_eligible',
  withdrawal_not_permitted: 'invalid_state',
  insufficient_funds: 'insufficient_funds',
  // The payment itself
  payment_not_found: 'invalid_request',
  payment_wrong_tenant: 'permission_error',
  payment_terminal: 'invalid_state',
  invalid_transition: 'invalid_state',
} as const satisfies Record<string, ApiErrorType>;

export type TreasuryErrorCode = keyof typeof TREASURY_ERROR_CODES;

export class TreasuryError extends Error {
  override readonly name = 'TreasuryError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: TreasuryErrorCode,
    message: string,
    readonly detail: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.apiType = TREASURY_ERROR_CODES[code];
  }
}

export function isTreasuryError(error: unknown, code?: TreasuryErrorCode): error is TreasuryError {
  return error instanceof TreasuryError && (code === undefined || error.code === code);
}
