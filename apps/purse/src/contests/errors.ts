import type { ApiErrorType } from '@purse/types';

/**
 * Every way the contest engine refuses a request, with the sealed error type (spec 4.7) a
 * route reports it under. Like `LedgerError`, these are refusals, never bugs; anything
 * unexpected propagates as-is. `not_eligible` and `insufficient_funds` codes carry
 * `reasons` and `requiredAction` in their detail using the spec 4.5 vocabulary: a decision
 * refused for want of funds alone is `insufficient_funds`, the money type of spec 4.7, and
 * any other refusal is `not_eligible` (docs/decisions.md).
 */
export const CONTEST_ERROR_CODES = {
  // Lookup and tenancy
  contest_not_found: 'invalid_request',
  contest_wrong_tenant: 'permission_error',
  // Input
  invalid_input: 'invalid_request',
  invalid_prize_structure: 'invalid_request',
  entry_amount_above_stake_limit: 'invalid_request',
  invalid_payout_hash: 'invalid_request',
  duplicate_user: 'invalid_request',
  external_id_taken: 'conflict',
  idempotency_conflict: 'conflict',
  // Lifecycle (spec 4.3)
  invalid_transition: 'invalid_state',
  invalid_contest_state: 'invalid_state',
  operator_required: 'permission_error',
  actor_not_allowed: 'permission_error',
  contest_has_entries: 'invalid_state',
  escrow_not_empty: 'invalid_state',
  results_incomplete: 'invalid_state',
  already_settled: 'invalid_state',
  already_voided: 'invalid_state',
  // Entries
  contest_not_open: 'not_eligible',
  contest_full: 'not_eligible',
  not_eligible: 'not_eligible',
  insufficient_funds: 'insufficient_funds',
  already_entered: 'conflict',
  not_a_participant: 'invalid_request',
  participant_not_active: 'invalid_state',
  // Scores
  scores_not_accepted: 'invalid_state',
  attempt_already_finished: 'conflict',
  // Close
  preview_hash_mismatch: 'conflict',
} as const satisfies Record<string, ApiErrorType>;

export type ContestErrorCode = keyof typeof CONTEST_ERROR_CODES;

export class ContestError extends Error {
  override readonly name = 'ContestError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: ContestErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = CONTEST_ERROR_CODES[code];
  }
}

export function isContestError(error: unknown, code?: ContestErrorCode): error is ContestError {
  return error instanceof ContestError && (code === undefined || error.code === code);
}
