/**
 * The one place the motion preference and the motion tokens are read from the browser, so
 * every JavaScript-driven transition (the count-up, the FLIP) takes the same branch the
 * stylesheet takes. Safe on the server: no window means no preference and the token
 * defaults.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Defaults mirror tokens.css so a test environment without computed styles animates on the spec's numbers. */
const TOKEN_DEFAULTS: Record<string, string> = {
  '--d-micro': '120ms',
  '--d-base': '220ms',
  '--d-enter': '420ms',
  '--d-draw': '700ms',
  '--ease-out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
  '--ease-in-out-quart': 'cubic-bezier(0.76, 0, 0.24, 1)',
};

/** A motion token as the document computes it (reduced motion shortens the durations there). */
export function motionToken(name: string): string {
  const fallback = TOKEN_DEFAULTS[name] ?? '';
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/** A duration token in milliseconds. */
export function motionDurationMs(name: '--d-micro' | '--d-base' | '--d-enter' | '--d-draw'): number {
  const raw = motionToken(name);
  const match = /^([\d.]+)(ms|s)$/.exec(raw);
  if (match === null) return Number.parseFloat(TOKEN_DEFAULTS[name] ?? '0') || 0;
  const n = Number.parseFloat(match[1] ?? '0');
  return match[2] === 's' ? n * 1000 : n;
}
