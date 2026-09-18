import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { pageExtensionsFor } from '../../next.config';

/**
 * `POST /api/dev/login` must be provably absent from a production build. The route file is
 * `route.dev.ts`; Next treats `route.<ext>` as a route only for the extensions in
 * `pageExtensions`, and `dev.ts` is listed only outside production. Both halves are
 * asserted here, so neither a rename nor a config edit can quietly ship the route.
 */
const APP_DIR = path.resolve(import.meta.dirname, '../../src/app');
const DEV_DIR = path.join(APP_DIR, 'api', 'dev');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('route.'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('dev-only login route', () => {
  it('lists the dev.ts extension outside production only', () => {
    expect(pageExtensionsFor('development')).toEqual(['dev.ts', 'ts', 'tsx']);
    expect(pageExtensionsFor('test')).toEqual(['dev.ts', 'ts', 'tsx']);
    expect(pageExtensionsFor(undefined)).toEqual(['dev.ts', 'ts', 'tsx']);
    expect(pageExtensionsFor('production')).toEqual(['ts', 'tsx']);
  });

  it("lives in a file only the dev extension list can see, and nothing under api/dev is a plain route", () => {
    expect(existsSync(path.join(DEV_DIR, 'login', 'route.dev.ts'))).toBe(true);
    const files = routeFiles(DEV_DIR).map((file) => path.basename(file));
    expect(files).toEqual(['route.dev.ts']);
  });

  it('every route file is matched by the extension list Next applies to it', () => {
    const matcher = (extensions: string[]) => new RegExp(`(^route|[\\\\/]route)\\.(?:${extensions.join('|')})$`);
    const all = routeFiles(path.join(APP_DIR, 'api'));
    const production = all.filter((file) => matcher(pageExtensionsFor('production')).test(file));
    const development = all.filter((file) => matcher(pageExtensionsFor('development')).test(file));
    expect(development.length).toBe(all.length);
    expect(all.length - production.length).toBe(1);
    expect(production.some((file) => file.includes(`${path.sep}dev${path.sep}`))).toBe(false);
  });
});
