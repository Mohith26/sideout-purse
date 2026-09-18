import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { SDK_VERSION } from '../src/index';

describe('@purse/sdk skeleton', () => {
  it('reports the same version as package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
