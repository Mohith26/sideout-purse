import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Decision D2: the two connection strings are never both loaded into one process. The
 * cheapest way to guarantee that is to make sure neither app's source can even name the
 * other's variable. This test greps everything under each app except generated output.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sql', '.css', '.example', '.yaml', '.yml', '.md']);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
      return SOURCE_EXTENSIONS.has(path.extname(entry.name)) || entry.name.startsWith('.env') ? [full] : [];
    }),
  );
  return files.flat();
}

async function filesMentioning(root: string, needle: string): Promise<string[]> {
  const files = await walk(root);
  const hits: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.includes(needle)) hits.push(path.relative(REPO_ROOT, file));
  }
  return hits;
}

describe('each app knows only its own database', () => {
  it('apps/purse never references SIDEOUT_DATABASE_URL', async () => {
    expect(await filesMentioning(path.join(REPO_ROOT, 'apps/purse'), 'SIDEOUT_DATABASE_URL')).toEqual([]);
  });

  it('apps/sideout never references PURSE_DATABASE_URL', async () => {
    expect(await filesMentioning(path.join(REPO_ROOT, 'apps/sideout'), 'PURSE_DATABASE_URL')).toEqual([]);
  });

  it('shared packages know neither connection string', async () => {
    const packages = path.join(REPO_ROOT, 'packages');
    expect(await filesMentioning(packages, 'PURSE_DATABASE_URL')).toEqual([]);
    expect(await filesMentioning(packages, 'SIDEOUT_DATABASE_URL')).toEqual([]);
  });

  it('each app names its own variable (so the test is not passing vacuously)', async () => {
    expect(await filesMentioning(path.join(REPO_ROOT, 'apps/purse/src'), 'PURSE_DATABASE_URL')).toContain('apps/purse/src/env.ts');
    expect(await filesMentioning(path.join(REPO_ROOT, 'apps/sideout/src'), 'SIDEOUT_DATABASE_URL')).toContain('apps/sideout/src/env.ts');
  });
});
