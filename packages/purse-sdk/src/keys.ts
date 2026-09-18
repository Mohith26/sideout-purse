/**
 * Publishable keys and the Purse origin they imply. A publishable key is
 * `pk_<environment>_<32 characters>` (spec 4.1); the environment tag picks the default
 * origin, so a partner on a live key never reaches the sandbox by accident. `purseOrigin`
 * at init overrides it for local development, where Purse runs on `http://localhost:4000`.
 */
export const PUBLISHABLE_KEY_SHAPE = /^pk_(sandbox|live)_[A-Za-z0-9]{32}$/;

export type KeyEnvironment = 'sandbox' | 'live';

export const DEFAULT_ORIGINS: Readonly<Record<KeyEnvironment, string>> = {
  live: 'https://purse.app',
  sandbox: 'https://sandbox.purse.app',
};

export function keyEnvironment(publishableKey: string): KeyEnvironment | undefined {
  const match = PUBLISHABLE_KEY_SHAPE.exec(publishableKey);
  return match === null ? undefined : (match[1] as KeyEnvironment);
}

/**
 * An origin is a scheme, a host and a port and nothing else: `https://purse.app`, never
 * a path or a trailing slash. Anything else would make the exact-origin `postMessage`
 * target (spec 4.8 rule 2) silently match nothing.
 */
export function normaliseOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.origin === 'null' || url.origin !== value.replace(/\/$/, '')) return undefined;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return url.origin;
}

export function resolveOrigin(publishableKey: string, override: string | undefined): string {
  const environment = keyEnvironment(publishableKey);
  if (environment === undefined) throw new RangeError('publishableKey must look like pk_sandbox_... or pk_live_...');
  if (override === undefined) return DEFAULT_ORIGINS[environment];
  const origin = normaliseOrigin(override);
  if (origin === undefined) throw new RangeError(`purseOrigin must be an origin such as https://purse.example, got ${override}`);
  return origin;
}
