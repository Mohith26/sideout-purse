import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where Sideout's migrations live at runtime. Next bundles server code under `.next/`, so
 * module-relative paths are unreliable; `next dev` and `next start` run with the app
 * directory as cwd, while Vitest runs from the repository root. Both are checked.
 */
export function migrationsFolder(): string {
  const candidates = [path.join(process.cwd(), 'drizzle'), path.join(process.cwd(), 'apps', 'sideout', 'drizzle')];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, 'meta', '_journal.json')));
  if (found === undefined) {
    throw new Error(`Sideout migrations folder not found; looked in ${candidates.join(', ')}`);
  }
  return found;
}
