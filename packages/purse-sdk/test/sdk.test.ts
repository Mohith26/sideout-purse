import { readFile } from 'node:fs/promises';

import { PROTOCOL_VERSION } from '@purse/types';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION as SDK_PROTOCOL_VERSION, SDK_VERSION } from '../src/index';

describe('@purse/sdk skeleton', () => {
  it('reports the same version as package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('speaks the protocol version @purse/types defines', () => {
    expect(SDK_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});
