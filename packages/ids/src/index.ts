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
  charity: 'chr',
} as const;

export type IdEntity = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdEntity];

/** A branded string such as `` `tnt_${string}` ``; the prefix is part of the type. */
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

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

/**
 * A POSIX regular expression suitable for a Postgres `CHECK (id ~ '...')` constraint,
 * so a mis-prefixed id can never be inserted even by hand.
 */
export function idCheckPattern(prefix: IdPrefix): string {
  return `^${prefix}_${UUID_V7}$`;
}
