import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { REQUEST_ID_HEADER } from '@purse/types';

import { middleware } from '../src/middleware';

describe('request id middleware', () => {
  it('forwards a well-formed caller id on request and response', () => {
    const request = new NextRequest('http://sideout.test/', { headers: { [REQUEST_ID_HEADER]: 'caller-req-42' } });
    const response = middleware(request);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('caller-req-42');
    // Next encodes the overridden request headers for the downstream handler.
    expect(response.headers.get('x-middleware-request-x-request-id')).toBe('caller-req-42');
  });

  it('mints an id when none is supplied', () => {
    const response = middleware(new NextRequest('http://sideout.test/health'));
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
