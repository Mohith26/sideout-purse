/**
 * Identity (spec 4.1, decision D8): users linked to the partner by `external_id`, the
 * verification state machine, restrictions and locations, plus the duplicate-identity
 * fingerprint (spec 4.6). Every write here goes through the audit log.
 */
export { UsersError, USERS_ERROR_CODES, isUsersError, type UsersErrorCode } from './errors';
export {
  upsertUser,
  getUser,
  findUserByExternalId,
  getVerification,
  upsertUserSchema,
  locationInputSchema,
  type UpsertUserFields,
  type UpsertUserInput,
  type UpsertedUser,
} from './users';
export { startVerification, REVERIFY_AFTER_DAYS, type StartVerificationInput, type StartedVerification } from './verification';
export {
  addRestriction,
  liftRestriction,
  listRestrictions,
  activeRestrictions,
  actorRef,
  USER_PLACEABLE_RESTRICTIONS,
  type AddRestrictionInput,
  type LiftRestrictionInput,
} from './restrictions';
export { resolveAndRecordLocation, recordLocation, locationOf, type LocationInput, type RecordLocationInput, type RecordedLocation } from './locations';
export { refreshFingerprint, identityFingerprint, normalizeName, type FingerprintResult } from './fingerprint';
export { loadProfile, profileOf, type UserProfile } from './profile';
