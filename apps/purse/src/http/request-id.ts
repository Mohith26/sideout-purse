import { randomUUID } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';
import { REQUEST_ID_HEADER } from '@purse/types';

import type { Logger } from '../logger';

/**
 * Accepts a caller's `X-Request-Id` when it looks like one (so Sideout's id survives the
 * hop), otherwise mints a UUID. Either way the id is echoed on the response and bound to a
 * request-scoped logger available as `c.get('logger')`.
 */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{8,128}$/;

export type RequestScope = {
  Variables: {
    requestId: string;
    logger: Logger;
  };
};

export function readOrMintRequestId(header: string | null | undefined): string {
  return header !== undefined && header !== null && REQUEST_ID_SHAPE.test(header) ? header : randomUUID();
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
