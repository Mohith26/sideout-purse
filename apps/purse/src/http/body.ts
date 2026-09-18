import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';

import { ApiFailure } from './envelope';
import { RequestValidationError } from './errors';

/**
 * Every mutation's body is read once, as JSON, into `c.get('body')`: the idempotency
 * middleware hashes it and the route validates it with Zod. An absent or empty body is
 * `{}` (an `open` needs none); anything that is not a JSON object is refused before any
 * handler runs. Bodies larger than `MAX_BODY_BYTES` are refused with 413.
 */
export const MAX_BODY_BYTES = 1_048_576;

export type BodyScope = { Variables: { body: Record<string, unknown> } };

const WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readBody(): MiddlewareHandler<BodyScope> {
  return async (c, next) => {
    if (!WITH_BODY.has(c.req.method)) {
      c.set('body', {});
      await next();
      return;
    }
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new ApiFailure({ type: 'invalid_request', code: 'body_too_large', message: `Request bodies are limited to ${MAX_BODY_BYTES} bytes` }, 413);
    }
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new ApiFailure({ type: 'invalid_request', code: 'body_too_large', message: `Request bodies are limited to ${MAX_BODY_BYTES} bytes` }, 413);
    }
    let parsed: unknown = {};
    if (text.trim() !== '') {
      const contentType = c.req.header('content-type') ?? '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new ApiFailure({ type: 'invalid_request', code: 'unsupported_media_type', message: 'Request bodies must be application/json' }, 415);
      }
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiFailure({ type: 'invalid_request', code: 'invalid_json', message: 'The request body is not valid JSON' });
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ApiFailure({ type: 'invalid_request', code: 'invalid_body', message: 'The request body must be a JSON object' });
    }
    c.set('body', parsed as Record<string, unknown>);
    await next();
  };
}

/** Validate the parsed body against a schema; a failure is `invalid_request` / `validation_failed` with every issue listed. */
export function parseBody<S extends z.ZodType>(c: Pick<Context<BodyScope>, 'get'>, schema: S): z.output<S> {
  const result = schema.safeParse(c.get('body'));
  if (!result.success) throw new RequestValidationError(result.error);
  return result.data;
}
