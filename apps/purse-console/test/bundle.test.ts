import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanBundle } from '../src/lib/bundle-check';

/**
 * Spec section 8: grep the built client bundle for `sk_`. The scanner is proven on a
 * synthetic bundle; `pnpm build` runs it on the real one after every `next build`, and
 * the assertion below runs against a build when one is present.
 */
describe('client bundle check', () => {
  it('finds a secret key, a webhook secret and a session token in a bundle, and passes a clean one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'purse-console-bundle-'));
    mkdirSync(path.join(dir, 'chunks'), { recursive: true });
    writeFileSync(path.join(dir, 'chunks', 'clean.js'), 'export const a = "pk_sandbox_abcdefgh12345678abcdefgh12345678";');
    expect(scanBundle(dir)).toEqual([]);
    // Assembled at runtime so no source file (and no commit) ever contains a key-shaped string.
    const key = ['sk', 'live', 'abcdefgh12345678abcdefgh12345678'].join('_');
    const secret = ['whsec', 'abcdefghijklmnop'].join('_');
    const token = ['cst', 'A'.repeat(43)].join('_');
    writeFileSync(path.join(dir, 'chunks', 'leak.js'), `const k = "${key}"; const w = "${secret}"; const t = "${token}";`);
    const names = scanBundle(dir).map((finding) => finding.name);
    expect(names).toContain('secret API key');
    expect(names).toContain('webhook signing secret');
    expect(names).toContain('console session token');
    expect(scanBundle(dir).every((finding) => finding.file === 'chunks/leak.js')).toBe(true);
  });

  it('the built console bundle carries no secret', ({ skip }) => {
    const staticDir = path.resolve(import.meta.dirname, '../.next/static');
    if (!existsSync(staticDir)) skip('no build present; `pnpm build` runs this check on the real bundle');
    expect(scanBundle(staticDir)).toEqual([]);
  });
});
