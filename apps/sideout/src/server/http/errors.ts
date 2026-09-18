import { API_ERROR_STATUS, type ApiErrorType } from '@purse/types';

/**
 * Sideout's API error taxonomy: Purse's sealed types (spec 4.7) plus `not_found`, which a
 * product API needs and a platform API deliberately folds into `invalid_request`. The
 * envelope is `{ error: { type, code, message, detail? } }`; clients branch on `type` and
 * `code`, never on `message`.
 */
export type SideoutErrorType = ApiErrorType | 'not_found';

export type SideoutApiError = {
  type: SideoutErrorType;
  code: string;
  message: string;
  detail?: unknown;
};

export const ERROR_STATUS: Readonly<Record<SideoutErrorType, number>> = { ...API_ERROR_STATUS, not_found: 404 };

/** A thrown error that already knows its envelope. Services throw it; `handle` renders it. */
export class ApiFailure extends Error {
  override readonly name = 'ApiFailure';
  readonly status: number;
  constructor(
    readonly error: SideoutApiError,
    status?: number,
  ) {
    super(error.message);
    this.status = status ?? ERROR_STATUS[error.type];
  }

  /** The same error rendered with a different HTTP status (a 503 for an unavailable dependency). */
  withStatus(status: number): ApiFailure {
    return new ApiFailure(this.error, status);
  }
}

const make =
  (type: SideoutErrorType) =>
  (code: string, message: string, detail?: unknown): ApiFailure =>
    new ApiFailure(detail === undefined ? { type, code, message } : { type, code, message, detail });

export const failure = {
  invalidRequest: make('invalid_request'),
  authentication: make('authentication_error'),
  permission: make('permission_error'),
  notFound: make('not_found'),
  invalidState: make('invalid_state'),
  conflict: make('conflict'),
  rateLimited: make('rate_limited'),
  internal: make('internal_error'),
};
