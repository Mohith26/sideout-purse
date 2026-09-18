import { z } from 'zod';

import { failure } from './errors';

/** Parse a JSON body against a schema; a malformed body or a shape mismatch is `invalid_request`. */
export async function parseJsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw failure.invalidRequest('malformed_json', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw failure.invalidRequest('validation_failed', 'The request did not match the expected shape.', z.treeifyError(parsed.error));
  }
  return parsed.data;
}

/** Parse the query string against a schema. */
export function parseQuery<T extends z.ZodType>(request: Request, schema: T): z.output<T> {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw failure.invalidRequest('validation_failed', 'The query string did not match the expected shape.', z.treeifyError(parsed.error));
  }
  return parsed.data;
}

/** Next 15 hands route handlers their dynamic segments as a promise. */
export type RouteContext<P extends Record<string, string>> = { params: Promise<P> };
