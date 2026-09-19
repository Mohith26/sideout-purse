import { isRequestId } from '@purse/types';

/**
 * Shared by the middleware (edge runtime) and route handlers (Node); Web APIs only, so the
 * same code runs in both.
 */
export function readOrMintRequestId(header: string | null | undefined): string {
  return isRequestId(header) ? header : globalThis.crypto.randomUUID();
}
