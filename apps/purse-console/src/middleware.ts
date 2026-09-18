import { NextResponse, type NextRequest } from 'next/server';
import { REQUEST_ID_HEADER } from '@purse/types';

import { readOrMintRequestId } from './lib/request-id';
import { CONSOLE_PATH_HEADER, SESSION_COOKIE } from './lib/session-cookie';

/**
 * Reads or mints `X-Request-Id` for every request and echoes it on the response; every
 * call the console makes to the Purse API carries it, so a console action can be traced
 * into the API's log lines. Also the first gate on the session: a page request with no
 * session cookie at all is sent to sign in with the path to come back to, before any
 * rendering; a cookie that is present but no longer valid is caught by the frame's
 * `/auth/me` read (`src/server/api.ts`). The current path travels to the server
 * components on `X-Console-Path` so that read can send the operator back too.
 */
const OPEN_PATHS = ['/login', '/api/auth/login'];

export function middleware(request: NextRequest) {
  const id = readOrMintRequestId(request.headers.get(REQUEST_ID_HEADER));
  const { pathname, search } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, id);
  requestHeaders.set(CONSOLE_PATH_HEADER, `${pathname}${search}`);

  const isPage = !pathname.startsWith('/api/');
  if (isPage && !OPEN_PATHS.includes(pathname) && request.cookies.get(SESSION_COOKIE) === undefined) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = pathname === '/' ? '' : `?next=${encodeURIComponent(`${pathname}${search}`)}`;
    const response = NextResponse.redirect(login);
    response.headers.set(REQUEST_ID_HEADER, id);
    return response;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, id);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
