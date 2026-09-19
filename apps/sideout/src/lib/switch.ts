/**
 * A boolean switch read from the environment: `true` or `1` (any case, surrounding
 * whitespace ignored) is on; anything else, including unset, is off. Shared by
 * `src/env.ts` (the runtime reading) and `next.config.ts` (the build-time derivation of
 * `NEXT_PUBLIC_DEMO_ACCOUNTS`), so the two cannot read one value two ways.
 */
export function switchFrom(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}
