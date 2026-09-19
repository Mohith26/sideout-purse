import { resolveBuildSha } from '@repo/logger';

let cached: string | undefined;

/** The commit sha `/health` reports, resolved once per process. */
export function buildSha(explicit: string | undefined): string {
  cached ??= resolveBuildSha(explicit);
  return cached;
}
