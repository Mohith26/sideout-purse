import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Acceptance criterion 12, checked at the source level as well as by lint: nothing under
 * `apps/sideout` imports from `apps/purse` or any `@purse/*` package other than the two
 * published ones. The lint rule is the enforcement; this is the proof it has nothing to
 * catch.
 */
const ROOT = path.resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}.next${path.sep}`));
}

const IMPORT = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g;

describe('Sideout never reaches into Purse', () => {
  it('imports no module from apps/purse and no @purse/* package beyond sdk and types', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'test', 'scripts']) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(IMPORT)) {
          const specifier = match[1] ?? '';
          const purseScoped = specifier.startsWith('@purse/') && specifier !== '@purse/sdk' && specifier !== '@purse/types';
          const relativeIntoPurse = /(^|\/)apps\/purse(\/|$)/.test(specifier) || /(^|\/)packages\/purse-/.test(specifier);
          if (purseScoped || relativeIntoPurse) offenders.push(`${path.relative(ROOT, file)}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shares no table with contest value: no Sideout column names a POINTS or CREDIT asset', () => {
    const schema = readFileSync(path.join(ROOT, 'src/db/schema.ts'), 'utf8');
    const columns = [...schema.matchAll(/^\s+(\w+): [a-zA-Z]+\('([a-z_]+)'/gm)].map((m) => m[2] ?? '');
    expect(columns.some((name) => /asset|points_balance|credit|escrow|payout|wallet/.test(name))).toBe(false);
    // Donations reference nothing Purse-related.
    const donationsBlock = schema.slice(schema.indexOf("pgTable(\n  'donations'"), schema.indexOf("pgTable(\n  'donation_provider_events'"));
    expect(donationsBlock).not.toMatch(/purse/i);
  });
});
