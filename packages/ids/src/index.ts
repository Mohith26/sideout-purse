/**
 * Identifiers for every row Purse or Sideout owns.
 *
 * An id is a UUID v7 (RFC 9562) with a short typed prefix, `tnt_019...`. The prefix makes
 * an id self-describing in a log line or a support ticket; the v7 layout makes ids sort
 * by creation time, so a primary-key index stays append-friendly and "the latest" is
 * `ORDER BY id`. UUID v7 is generated per process with a monotonic counter inside one
 * millisecond, so ids minted back to back stay ordered even at high rates.
 *
 * Every table checks its own prefix at the database level; see `idCheckPattern`.
 */
import { v7 as uuidv7, validate as isUuid, version as uuidVersion } from 'uuid';

/**
 * The registry. One prefix per entity, unique across both services so an id read out of
 * a cross-service trace is never ambiguous. Prefixes named in system spec 4.1 are kept
 * verbatim; later phases add entries here, never inline.
 */
export const ID_PREFIXES = {
  // Purse (system spec 4.1)
  tenant: 'tnt',
  user: 'usr',
  contest: 'cnt',
  account: 'acct',
  entry: 'ent',
  transaction: 'txn',
  auditEvent: 'aud',
  // Sideout (system spec 5.1)
  sideoutUser: 'sou',
  charity: 'chr',
  /** The opaque value Sideout hands Purse as `external_id`; never Sideout's own row id. */
  externalId: 'ext',
} as const;

export type IdEntity = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdEntity];

/** A branded string such as `` `tnt_${string}` ``; the prefix is part of the type. */
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export class InvalidIdError extends Error {
  override readonly name = 'InvalidIdError';
  constructor(
    readonly value: unknown,
    readonly expectedPrefix: IdPrefix,
  ) {
    super(`Expected an id with prefix "${expectedPrefix}_", got ${describe(value)}`);
  }
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : typeof value;
}

/** Mint a new id for the given prefix. */
export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${uuidv7()}`;
}

/** True when `value` is a well-formed id carrying exactly this prefix. */
export function isId<P extends IdPrefix>(value: unknown, prefix: P): value is Id<P> {
  if (typeof value !== 'string') return false;
  const marker = `${prefix}_`;
  if (!value.startsWith(marker)) return false;
  const uuid = value.slice(marker.length);
  return isUuid(uuid) && uuidVersion(uuid) === 7;
}

/** Narrow an untrusted string to an id, or throw `InvalidIdError`. */
export function parseId<P extends IdPrefix>(value: unknown, prefix: P): Id<P> {
  if (isId(value, prefix)) return value;
  throw new InvalidIdError(value, prefix);
}

/** The creation instant encoded in a v7 id (millisecond precision). */
export function idTimestamp(id: Id): Date {
  const uuid = id.slice(id.indexOf('_') + 1);
  if (!isUuid(uuid) || uuidVersion(uuid) !== 7) {
    throw new InvalidIdError(id, prefixOf(id));
  }
  // The first 48 bits of a v7 UUID are unix milliseconds, big-endian.
  const millis = Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
  return new Date(millis);
}

/** The prefix portion of an id string, typed loosely because the input is untrusted. */
export function prefixOf(id: string): IdPrefix {
  return id.slice(0, id.indexOf('_')) as IdPrefix;
}

/**
 * A POSIX regular expression suitable for a Postgres `CHECK (id ~ '...')` constraint,
 * so a mis-prefixed id can never be inserted even by hand.
 */
export function idCheckPattern(prefix: IdPrefix): string {
  return `^${prefix}_${UUID_V7}$`;
}

/** The JavaScript counterpart of `idCheckPattern`, for validating at the edge. */
export function idRegExp(prefix: IdPrefix): RegExp {
  return new RegExp(idCheckPattern(prefix));
}
