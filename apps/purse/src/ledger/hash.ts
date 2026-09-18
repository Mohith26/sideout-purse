import { createHash } from 'node:crypto';

/**
 * A stable digest of a request so an idempotent replay can be told apart from a different
 * request reusing a key. Keys are sorted recursively, `undefined` is dropped and bigints
 * become decimal strings, so two callers describing the same entry hash the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = canonicalise(inner);
    }
    return out;
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
