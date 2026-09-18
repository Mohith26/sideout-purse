/**
 * Pure conversions the event builder needs on both sides: dollars typed in a field to
 * decimal cent strings (never a float on the money path), and instants to and from the
 * `datetime-local` value in the venue's zone. Plain module, so a server page can prefill
 * the form with them.
 */
/** "$75", "75.00", "1,250.5" → cents as a decimal string. Null for anything that is not a non-negative amount with at most two decimals. */
export function dollarsToCents(input: string): string | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
}

/** Cents → "75" or "12.50", the value an amount input shows. */
export function centsToDollars(cents: string): string {
  const value = BigInt(cents);
  const whole = value / 100n;
  const fraction = value % 100n;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** An instant as the `datetime-local` value in a zone, and back. */
export function toWallClock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}

export function fromWallClock(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (match === null) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined) return null;
  // Find the instant whose wall clock in `timeZone` is the typed one: start from UTC and correct by the zone's offset at that instant.
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number) => {
    const wall = toWallClock(new Date(ms).toISOString(), timeZone);
    const [dp, tp] = wall.split('T');
    const [wy, wm, wd] = (dp ?? '').split('-').map(Number);
    const [wh, wmi] = (tp ?? '').split(':').map(Number);
    return Date.UTC(wy ?? 0, (wm ?? 1) - 1, wd ?? 1, wh ?? 0, wmi ?? 0) - ms;
  };
  const first = guess - offsetAt(guess);
  const second = guess - offsetAt(first);
  return new Date(second).toISOString();
}

