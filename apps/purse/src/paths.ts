import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The migrations folder relative to this source tree. Resolved from the module URL so it
 * is right whether the app runs from `src/` under tsx or from the bundled `dist/index.js`;
 * both live one directory below the app root.
 */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_FOLDER = path.join(APP_ROOT, 'drizzle');
