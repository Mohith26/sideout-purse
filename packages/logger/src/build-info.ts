import { execFileSync } from 'node:child_process';

/**
 * The commit sha each app's `/health` reports. `BUILD_SHA` is set by the deploy pipeline;
 * a developer checkout falls back to the git HEAD, and anything else reports "unknown"
 * rather than guessing.
 */
export function resolveBuildSha(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : 'unknown';
  } catch {
    // Not a git checkout (a container image, a tarball): there is no sha to report.
    return 'unknown';
  }
}
