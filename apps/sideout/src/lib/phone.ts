/**
 * Phone helpers for the browser. The server's `auth/phone.ts` is the validator of record
 * (E.164); this only normalises what a person types and masks what is shown.
 */

/** A ten-digit US number becomes `+1...`; anything else must already be international. Null when it cannot be. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  const bare = digits.replace(/^\+/, '');
  if (/^\d{10}$/.test(bare)) return `+1${bare}`;
  if (/^1\d{10}$/.test(bare)) return `+${bare}`;
  return null;
}

/**
 * `+14155550123` → `+1 ••• 0123`: enough to recognise, never the whole number. Country
 * codes are one to three digits and not self-delimiting; `+1` (NANP) and `+7` are the
 * one-digit ones, everything else here is shown with two, which covers the numbers the
 * seed and the pilot use without carrying a country table into the browser.
 */
export function maskPhone(e164: string): string {
  const last = e164.slice(-4);
  const digits = e164.replace(/^\+/, '');
  const country = /^[17]/.test(digits) ? digits.slice(0, 1) : digits.slice(0, 2);
  return `+${country} ••• ${last}`;
}
