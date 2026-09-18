/**
 * The operator console's accounts and sessions (spec 4.10, "behind its own auth"):
 * argon2id passwords, stateful bearer sessions, every change audited. The console's
 * routes are `src/routes/console/`.
 */
export { OperatorError, OPERATOR_ERROR_CODES, isOperatorError, type OperatorErrorCode } from './errors';
export {
  createOperator,
  findOperatorByEmail,
  getOperator,
  listOperators,
  setPassword,
  generatePassword,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  validatePassword,
  operatorActor,
  publicFields as operatorPublicFields,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  GENERATED_PASSWORD_LENGTH,
  type CreateOperatorInput,
  type SetPasswordInput,
} from './operators';
export {
  signIn,
  authenticateSession,
  revokeSession,
  revokeOtherSessions,
  mintSessionToken,
  hashSessionToken,
  SESSION_TOKEN_PREFIX,
  SESSION_TTL_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  type SignInInput,
  type SignedIn,
  type AuthenticatedOperator,
  type RevokeSessionInput,
} from './sessions';
