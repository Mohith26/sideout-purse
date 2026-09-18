/**
 * The engine refuses an input it cannot settle honestly. These are caller bugs (a duplicate
 * entrant, a pool with nobody to pay), never arithmetic surprises: valid input always
 * settles, and settles exactly.
 */
export const SETTLEMENT_ERROR_CODES = ['duplicate_entrant', 'invalid_entry', 'negative_escrow', 'no_recipients', 'invalid_structure'] as const;

export type SettlementErrorCode = (typeof SETTLEMENT_ERROR_CODES)[number];

export class SettlementError extends Error {
  override readonly name = 'SettlementError';

  constructor(
    readonly code: SettlementErrorCode,
    message: string,
    readonly detail: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
  }
}

export function isSettlementError(error: unknown, code?: SettlementErrorCode): error is SettlementError {
  return error instanceof SettlementError && (code === undefined || error.code === code);
}
