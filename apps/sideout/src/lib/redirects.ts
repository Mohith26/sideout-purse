/** Only a same-origin path is honoured as a `next` target; anything else falls back. */
export function safeNextPath(value: string | string[] | undefined, fallback: string): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  return raw;
}

export function signInHref(next: string): string {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}
