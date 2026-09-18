import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Spec 4.8 rule 2: every `postMessage` names an exact target origin, never `'*'`. The
 * whole SDK source is read and every call site is checked; the one place a message
 * leaves the SDK is `Purse.post`, and it targets `this.origin`.
 */
const SRC = path.resolve(import.meta.dirname, '../src');

describe('postMessage target origins', () => {
  it('no call site passes "*"', async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const sites: Array<{ file: string; call: string }> = [];
    for (const file of files) {
      const source = await readFile(path.join(SRC, file), 'utf8');
      for (const match of source.matchAll(/postMessage\s*\(([^)]*)\)/g)) sites.push({ file, call: match[1] ?? '' });
    }
    expect(sites.length).toBe(1);
    for (const site of sites) {
      expect(site.call, `${site.file}: ${site.call}`).not.toMatch(/['"`]\*['"`]/);
      expect(site.call).toMatch(/this\.origin/);
    }
  });
});
