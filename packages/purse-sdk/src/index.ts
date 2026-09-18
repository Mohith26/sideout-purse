/**
 * The partner-facing client for embedding Purse flows (system spec section 4.8) and the
 * receiver half of Purse's webhooks (4.9). Framework-agnostic; depends only on
 * `@purse/types`, which carries the message protocol both sides validate against.
 */
export { SDK_VERSION } from './version';
export {
  Purse,
  PurseError,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  type PurseInitOptions,
  type MountOptions,
  type Mounted,
  type PurseEvents,
  type PurseEventName,
  type Handler,
} from './purse';
export { DEFAULT_ORIGINS, PUBLISHABLE_KEY_SHAPE, keyEnvironment, normaliseOrigin, resolveOrigin, type KeyEnvironment } from './keys';
export {
  signWebhook,
  verifyWebhook,
  parseSignatureHeader,
  constantTimeEqual,
  SIGNATURE_SCHEME,
  type SignedHeader,
  type VerifyOptions,
  type VerifyFailure,
  type VerifyResult,
  type ParsedSignature,
} from './webhooks';
