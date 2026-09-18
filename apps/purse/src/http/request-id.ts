import type { MiddlewareHandler } from 'hono';
import { REQUEST_ID_HEADER, isRequestId } from '@purse/types';
import type { Logger } from '@repo/logger';

/**
 * Accepts a caller's `X-Request-Id` when it looks like one (so Sideout's id survives the
 * hop), otherwise mints a UUID. Either way the id is echoed on the response and bound to a
 * request-scoped logger available as `c.get('logger')`.
 */
export type RequestScope = {
  Variables: {
    requestId: string;
    logger: Logger;
  };
};

export function readOrMintRequestId(header: string | null | undefined): string {
  return isRequestId(header) ? header : globalThis.crypto.randomUUID();
}

export function requestId(baseLogger: Logger): MiddlewareHandler<RequestScope> {
  return async (c, next) => {
    const id = readOrMintRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set('requestId', id);
    c.set('logger', baseLogger.child({ requestId: id }));
    c.header(REQUEST_ID_HEADER, id);
    await next();
  };
}
