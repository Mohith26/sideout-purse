import { describe, expect, it, vi } from 'vitest';

import { ApiFailure } from '../src/server/http/errors';
import { handle } from '../src/server/http/respond';
import { errorOf, request } from './helpers';

describe('handle', () => {
  it('renders an ApiFailure thrown from an earlier copy of the server modules as its envelope, not a 500', async () => {
    // Under `next dev` webpack re-evaluates `src/server/**` when it compiles another
    // route, while the services cached on `globalThis` (server/context.ts) keep the copy
    // they were built from; the failure a service throws can therefore be an instance
    // of a different `ApiFailure` class than the one `handle` imported.
    vi.resetModules();
    const stale = await import('../src/server/http/errors');
    expect(stale.ApiFailure).not.toBe(ApiFailure);
    const thrown = stale.failure.authentication('code_invalid', 'That code is not right.');
    expect(thrown instanceof ApiFailure).toBe(false);

    const response = await handle(request('POST', '/api/auth/verify'), async () => {
      throw thrown;
    });
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual({ type: 'authentication_error', code: 'code_invalid', message: 'That code is not right.' });
  });
});
