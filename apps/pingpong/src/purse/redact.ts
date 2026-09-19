/**
 * What may not reach the `purse_calls` audit or a log line: the secret key (spec section
 * 2, rule 2), a webhook signing secret, and the one-time embed tokens Purse hands back.
 * Applied to every stored request and response body, and to any error message, so the
 * `/audit` page can show full bodies without ever showing a credential.
 */
const KEY_SHAPES = [/\bsk_(?:sandbox|live)_[A-Za-z0-9]+/g, /\bwhsec_[A-Za-z0-9]+/g, /\bembt_[A-Za-z0-9_-]+/g];
const SECRET_FIELDS = new Set(['token', 'secret', 'secretKey', 'signingSecret', 'embedToken', 'authorization']);

export const REDACTED = '[redacted]';

export function redactString(value: string): string {
  return KEY_SHAPES.reduce((text, shape) => text.replace(shape, REDACTED), value);
}

/** A deep copy of `value` with secret-shaped strings and secret-named fields replaced. `bigint` becomes a decimal string. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_FIELDS.has(key) && typeof child === 'string' && child.length > 0 ? REDACTED : redact(child);
    }
    return out;
  }
  return value;
}
