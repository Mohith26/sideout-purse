import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The half of the secret-key rule that runs before a build: no module a browser could
 * load (a `'use client'` component, or anything under `src/app` that is not a route
 * handler or a server component) imports the Purse client or names the secret; the other
 * half, `scripts/check-bundle.ts`, greps the built client bundle for `sk_` and runs as
 * part of `pnpm build`.
 */
const SRC = path.resolve(import.meta.dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

const files = walk(SRC).map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }));
const clientModules = files.filter((f) => /^\s*['"]use client['"]/m.test(f.text));

describe('the secret key never reaches a browser', () => {
  it('client components exist and none imports the Purse client, a server module, or names the secret', () => {
    expect(clientModules.length).toBeGreaterThan(0);
    for (const { file, text } of clientModules) {
      expect(text, file).not.toMatch(/from ['"][^'"]*\/purse(\/|['"])/);
      expect(text, file).not.toMatch(/from ['"][^'"]*\/server\//);
      expect(text, file).not.toMatch(/PURSE_SECRET_KEY|PURSE_WEBHOOK_SECRET|sk_(sandbox|live)_/);
      expect(text, file).not.toMatch(/from ['"][^'"]*\/env['"]/);
    }
  });

  it('no source file carries a literal secret key', () => {
    for (const { file, text } of files) expect(text, file).not.toMatch(/sk_(sandbox|live)_[A-Za-z0-9]{32}/);
  });

  it('the build greps the client bundle', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(SRC, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).toBe('next build && tsx scripts/check-bundle.ts');
    expect(readFileSync(path.resolve(SRC, '..', 'scripts', 'check-bundle.ts'), 'utf8')).toMatch(/sk_\(sandbox\|live\)_/);
  });
});
