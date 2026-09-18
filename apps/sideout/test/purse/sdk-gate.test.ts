import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `PurseGate` is the one browser-facing module that mounts `@purse/sdk` flows (spec 4.8):
 * every other page and component reaches Purse through `usePurse()`. The lint rule in
 * `packages/config/eslint/boundary.js` refuses other imports; this walks the source so a
 * lint-disabled line cannot slip past either. Server modules may still use the SDK's
 * server helpers (`verifyWebhook`, `SDK_VERSION`).
 */
const SRC = path.resolve(import.meta.dirname, '..', '..', 'src');
const GATE = 'components/purse/PurseGate.tsx';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

const files = walk(SRC).map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }));

describe('the SDK import boundary', () => {
  it('only PurseGate imports @purse/sdk among browser-facing modules', () => {
    const browserFacing = files.filter((f) => f.file.startsWith('app/') || f.file.startsWith('components/') || f.file.startsWith('lib/'));
    const importers = browserFacing.filter((f) => /from ['"]@purse\/sdk['"]/.test(f.text)).map((f) => f.file);
    expect(importers).toEqual([GATE]);
  });

  it('PurseGate is a client component that never names the secret key or a server module', () => {
    const gate = files.find((f) => f.file === GATE);
    expect(gate).toBeDefined();
    expect(gate?.text).toMatch(/^'use client';/);
    expect(gate?.text).not.toMatch(/PURSE_SECRET_KEY|sk_(sandbox|live)_/);
    expect(gate?.text).not.toMatch(/from ['"][^'"]*\/server\//);
  });

  it('every other component that needs a flow goes through usePurse', () => {
    const users = files.filter((f) => f.file.startsWith('components/') && f.file !== GATE && /usePurse(Optional)?\(\)/.test(f.text)).map((f) => f.file);
    expect(users).toEqual(expect.arrayContaining(['components/purse/VerificationRow.tsx', 'components/purse/WalletChip.tsx', 'components/registration/PurseEntryStep.tsx']));
  });
});
