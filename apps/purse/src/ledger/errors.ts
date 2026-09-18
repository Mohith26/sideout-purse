import type { ApiErrorType } from '@purse/types';

/**
 * Every way the ledger refuses a request. The `code` is stable and machine-readable; the
 * `apiType` is the sealed error type a route reports it under (spec 4.7). Ledger errors
 * are refusals, never bugs: an unexpected database failure propagates as-is.
 */
export const LEDGER_ERROR_CODES = {
  // Journal rules (spec 4.2.2)
  too_few_lines: 'invalid_request',
  non_positive_amount: 'invalid_request',
  amount_too_large: 'invalid_request',
  mixed_assets: 'invalid_request',
  unbalanced: 'invalid_request',
  invalid_idempotency_key: 'invalid_request',
  invalid_description: 'invalid_request',
  idempotency_conflict: 'conflict',
  // Explorer reads (spec 4.10)
  invalid_input: 'invalid_request',
  // Accounts
  account_not_found: 'invalid_request',
  account_wrong_tenant: 'permission_error',
  account_not_open: 'invalid_state',
  account_asset_mismatch: 'invalid_request',
  account_kind_mismatch: 'invalid_request',
  insufficient_funds: 'insufficient_funds',
  // Reversals
  entry_not_found: 'invalid_request',
  entry_wrong_tenant: 'permission_error',
  already_reversed: 'invalid_state',
  reversal_mismatch: 'invalid_request',
  not_reversible: 'invalid_state',
} as const satisfies Record<string, ApiErrorType>;

export type LedgerErrorCode = keyof typeof LEDGER_ERROR_CODES;

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly detail: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.apiType = LEDGER_ERROR_CODES[code];
  }
}

export function isLedgerError(error: unknown, code?: LedgerErrorCode): error is LedgerError {
  return error instanceof LedgerError && (code === undefined || error.code === code);
}
