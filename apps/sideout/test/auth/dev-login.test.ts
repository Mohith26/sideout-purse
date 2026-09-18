import { describe, expect, it } from 'vitest';

import { pageExtensionsFor } from '../../next.config';

/**
 * `POST /api/dev/login` lives in `route.dev.ts`, and Next treats `route.<ext>` as a route
 * only for the extensions in `pageExtensions`. This proves the half that is executable
 * here: `dev.ts` is listed only outside production. That the production build really has
 * no such route is checked against the build's route manifest by `scripts/check-bundle.ts`
 * as part of `pnpm build` (docs/decisions.md, phase 9).
 */
describe('dev-only login route', () => {
  it('lists the dev.ts extension outside production only', () => {
    expect(pageExtensionsFor('development')).toEqual(['dev.ts', 'ts', 'tsx']);
    expect(pageExtensionsFor('test')).toEqual(['dev.ts', 'ts', 'tsx']);
    expect(pageExtensionsFor(undefined)).toEqual(['dev.ts', 'ts', 'tsx']);
    expect(pageExtensionsFor('production')).toEqual(['ts', 'tsx']);
  });
});
