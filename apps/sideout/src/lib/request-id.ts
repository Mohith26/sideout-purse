/**
 * Request id handling shared by the middleware (edge runtime) and route handlers (Node).
 * Uses only Web APIs so the same code runs in both.
 */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accept a caller's well-formed id, otherwise mint one. */
export function readOrMintRequestId(header: string | null | undefined): string {
  return header !== undefined && header !== null && REQUEST_ID_SHAPE.test(header) ? header : crypto.randomUUID();
}
