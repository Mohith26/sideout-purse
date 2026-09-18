/**
 * Authentication (spec 4.1 API keys, 4.8 embed tokens). Keys are hashed with argon2id and
 * looked up by prefix; embed tokens are single-use, five-minute, SHA-256-stored.
 */
export { AuthError, AUTH_ERROR_CODES, isAuthError, type AuthErrorCode } from './errors';
export {
  createApiKey,
  revokeApiKey,
  authenticateApiKey,
  listApiKeys,
  actorFor,
  keyPrefixOf,
  hashApiKey,
  publicFields,
  resetAuthCaches,
  KEY_SHAPE,
  KEY_PREFIX_LENGTH,
  KEY_SECRET_LENGTH,
  LAST_USED_WRITE_INTERVAL_MS,
  type CreateApiKeyInput,
  type CreatedApiKey,
  type RevokeApiKeyInput,
  type AuthenticatedKey,
  type AuthenticateOptions,
} from './api-keys';
export {
  issueEmbedToken,
  consumeEmbedToken,
  hashEmbedToken,
  EMBED_TOKEN_TTL_MS,
  EMBED_TOKEN_PREFIX,
  type IssueEmbedTokenInput,
  type IssuedEmbedToken,
  type ConsumeEmbedTokenInput,
} from './embed-tokens';
