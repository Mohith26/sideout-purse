import type { ApiErrorType } from '@purse/types';

export const WEBHOOK_ERROR_CODES = {
  endpoint_not_found: 'invalid_request',
  endpoint_wrong_tenant: 'permission_error',
  delivery_not_found: 'invalid_request',
  delivery_wrong_tenant: 'permission_error',
  url_not_allowed: 'invalid_request',
  invalid_input: 'invalid_request',
  endpoint_disabled: 'invalid_state',
} as const satisfies Record<string, ApiErrorType>;

export type WebhookErrorCode = keyof typeof WEBHOOK_ERROR_CODES;

export class WebhookError extends Error {
  override readonly name = 'WebhookError';
  readonly apiType: ApiErrorType;

  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.apiType = WEBHOOK_ERROR_CODES[code];
  }
}

export function isWebhookError(error: unknown, code?: WebhookErrorCode): error is WebhookError {
  return error instanceof WebhookError && (code === undefined || error.code === code);
}
