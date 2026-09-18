/**
 * Display formatting. Every figure on screen is derived from rows (spec 7, "numbers that
 * do not add up") and then formatted here; nothing is typed in a component. Cents arrive
 * as decimal strings or `bigint` and never pass through a float: the whole dollars and the
 * remainder are split with integer arithmetic, and `Intl.NumberFormat` formats the whole
 * as a `bigint`.
 */

export type Cents = string | bigint;

function toBigInt(cents: Cents): bigint {
  return typeof cents === 'bigint' ? cents : BigInt(cents);
}

/** `"5000"` → `$50`, `"1250"` → `$12.50`. A currency's minor unit is assumed to be a hundredth. */
export function formatCents(cents: Cents, currency = 'USD'): string {
  const value = toBigInt(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const fraction = abs % 100n;
  const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(whole);
  const withFraction = fraction === 0n ? formatted : `${formatted}.${fraction.toString().padStart(2, '0')}`;
  return negative ? `−${withFraction}` : withFraction;
}

/** Integer percent of `part` over `whole`, floored, never above 100; 0 when the goal is 0. Mirrors `server/money.ts`. */
export function percentOf(part: Cents, whole: Cents): number {
  const w = toBigInt(whole);
  if (w <= 0n) return 0;
  const pct = (toBigInt(part) * 100n) / w;
  return Number(pct > 100n ? 100n : pct);
}

/** Percent as a label, from an integer. */
export function formatPercent(percent: number): string {
  return `${Math.max(0, Math.round(percent))}%`;
}

export function addCents(a: Cents, b: Cents): string {
  return (toBigInt(a) + toBigInt(b)).toString();
}

export function subtractCents(a: Cents, b: Cents): string {
  return (toBigInt(a) - toBigInt(b)).toString();
}

export function compareCents(a: Cents, b: Cents): number {
  const x = toBigInt(a);
  const y = toBigInt(b);
  return x === y ? 0 : x > y ? 1 : -1;
}

export function sumCents(values: readonly Cents[]): string {
  return values.reduce<bigint>((total, each) => total + toBigInt(each), 0n).toString();
}

/** A POINTS or CREDIT amount (integer minor units, decision D3): grouped digits and the asset. */
export function formatPoints(amount: Cents, asset: string): string {
  const value = toBigInt(amount);
  const grouped = new Intl.NumberFormat('en-US').format(value);
  return `${grouped} ${asset}`;
}

const isoMs = (iso: string | Date): number => (iso instanceof Date ? iso.getTime() : Date.parse(iso));

export function formatDate(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(new Date(isoMs(iso)));
}

export function formatTime(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(isoMs(iso)));
}

export function formatDateTime(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(isoMs(iso)));
}

export function formatDateRange(startIso: string | Date, endIso: string | Date, timeZone: string): string {
  const sameDay = formatDate(startIso, timeZone) === formatDate(endIso, timeZone);
  if (sameDay) return `${formatDate(startIso, timeZone)} · ${formatTime(startIso, timeZone)}–${formatTime(endIso, timeZone)}`;
  return `${formatDate(startIso, timeZone)} – ${formatDate(endIso, timeZone)}`;
}

/** "in 3 days", "in 5 weeks", "2 months ago": coarse, for cards. */
export function formatRelative(targetIso: string | Date, nowMs: number): string {
  const diff = isoMs(targetIso) - nowMs;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  if (abs < 2 * week) return rtf.format(Math.round(diff / day), 'day');
  if (abs < 8 * week) return rtf.format(Math.round(diff / week), 'week');
  return rtf.format(Math.round(diff / (30 * day)), 'month');
}

/** Whole-unit countdown parts for the sticky header; null once the moment has passed. */
export function countdownParts(targetIso: string | Date, nowMs: number): { days: number; hours: number; minutes: number } | null {
  const diff = isoMs(targetIso) - nowMs;
  if (diff <= 0) return null;
  const minutes = Math.floor(diff / 60_000);
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

/** Initials for an avatar disc: "Maya Delgado" → "MD". */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter((p) => p !== '');
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** The first name, for a compact roster line. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

export function ordinal(n: number): string {
  const rules = new Intl.PluralRules('en-US', { type: 'ordinal' });
  const suffix = { one: 'st', two: 'nd', few: 'rd', other: 'th', zero: 'th', many: 'th' }[rules.select(n)];
  return `${n}${suffix}`;
}

/** "+12", "−4", "0": a signed differential with a real minus sign. */
export function formatSigned(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

/** A snake_case enum value as words. */
export function words(value: string): string {
  return value.replace(/_/g, ' ');
}
