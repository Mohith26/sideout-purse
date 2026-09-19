import { NextResponse, type NextRequest } from 'next/server';
import { REQUEST_ID_HEADER } from '@purse/types';

import { readOrMintRequestId } from './lib/request-id';

/**
 * Reads or mints `X-Request-Id` for every request, forwards it to the handler on the
 * request headers, and echoes it on the response. Handlers read it with `headers()` (or
 * `request.headers`) and pass it to Purse on every call, which is what lets one ladder
 * request be traced into the Purse calls it caused.
 */
export function middleware(request: NextRequest) {
  const id = readOrMintRequestId(request.headers.get(REQUEST_ID_HEADER));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, id);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, id);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
