/**
 * The iframe message protocol between `@purse/sdk` in the partner page and the Purse
 * embed app (system spec section 4.8).
 *
 * Phase 0 fixes only the envelope: every message carries `v` from the first commit so a
 * mismatched SDK and embed can refuse each other instead of guessing. Phase 4 fills in
 * the handshake and flow variants, keeps them as a discriminated union on `type`, and
 * validates each with a Zod schema on receipt.
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * The shape every message shares. `nonce` is established by the handshake and required
 * on everything after it; it is `null` only on the handshake's opening message.
 */
export type ProtocolEnvelope<TType extends string, TPayload> = {
  v: ProtocolVersion;
  type: TType;
  nonce: string | null;
  payload: TPayload;
};

/**
 * Placeholder for the union of messages the parent page sends the embed. Phase 4 replaces
 * `string, unknown` with the real variants.
 */
export type ParentToEmbedMessage = ProtocolEnvelope<string, unknown>;

/** Placeholder for the union of messages the embed sends the parent page. */
export type EmbedToParentMessage = ProtocolEnvelope<string, unknown>;

/** True when `value` is an envelope of the protocol version this build speaks. */
export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['v'] === PROTOCOL_VERSION &&
    typeof v['type'] === 'string' &&
    (v['nonce'] === null || typeof v['nonce'] === 'string') &&
    'payload' in v
  );
}
