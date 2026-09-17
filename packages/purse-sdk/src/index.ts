/**
 * The partner-facing client for embedding Purse flows (system spec section 4.8). Phase 4
 * implements the iframe, handshake and message validation; phase 0 ships only the version
 * both `/health` endpoints report and the protocol version the embed will speak.
 */
export { SDK_VERSION } from './version';
export { PROTOCOL_VERSION } from '@purse/types';
