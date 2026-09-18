/** Presentation helpers. Dates are shown in UTC with the zone named, so two operators in two places read the same instant. */
export function formatInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}Z`;
}

/** An id's tail, for a dense cell; the full id is the title. */
export function shortId(id: string): string {
  const underscore = id.indexOf('_');
  return underscore === -1 ? id : `${id.slice(0, underscore + 1)}…${id.slice(-6)}`;
}

export function titleCase(value: string): string {
  return value.replaceAll('_', ' ');
}
