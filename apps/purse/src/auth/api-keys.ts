import { createHash, randomInt } from 'node:crypto';

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { apiKeys, sandboxLeases, tenants, type ApiKey, type ApiKeyEnvironment, type ApiKeyKind, type ApiKeyScope, type Tenant } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { AuthError } from './errors';

/**
 * API keys (spec 4.1): `sk_` secret keys for server-to-server calls, `pk_` publishable
 * keys that only bootstrap the iframe, each tagged `sandbox` or `live` in its visible
 * prefix (`sk_sandbox_...`; docs/decisions.md). Only an argon2id hash is stored; the
 * plaintext is returned once, by `createApiKey`, and never logged.
 *
 * Authentication finds the candidate row by `key_prefix` (the first eight random
 * characters, an index lookup) and then verifies the argon2 hash. argon2id is deliberately
 * slow, so verified keys are remembered for a few minutes by the digest of their
 * plaintext, and `last_used_at` is written at most once a minute per key.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const KEY_SECRET_LENGTH = 32;
export const KEY_PREFIX_LENGTH = 8;
export const KEY_SHAPE = /^(sk|pk)_(sandbox|live)_([A-Za-z0-9]{32})$/;

/**
 * OWASP's argon2id minimum (19 MiB, 2 iterations, 1 lane): a few milliseconds per
 * verification. `algorithm: 2` is `Algorithm.Argon2id`, spelled out because the package
 * declares an ambient const enum, which `verbatimModuleSyntax` cannot import.
 */
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const VERIFIED_CACHE_TTL_MS = 5 * 60_000;
const VERIFIED_CACHE_MAX = 1000;

export type CreateApiKeyInput = {
  tenantId: Id<'tnt'>;
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
  scopes?: readonly ApiKeyScope[];
  label?: string | null;
  expiresAt?: Date;
  actor?: Actor;
  requestId?: string;
};

export type CreatedApiKey = {
  key: ApiKey;
  /** The whole key, shown exactly once. */
  plaintext: string;
};

function randomSecret(): string {
  let out = '';
  for (let i = 0; i < KEY_SECRET_LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function keyPrefixOf(plaintext: string): string {
  const match = KEY_SHAPE.exec(plaintext);
  if (match === null) throw new AuthError('invalid_input', 'not an API key');
  return `${match[1]}_${match[2]}_${(match[3] ?? '').slice(0, KEY_PREFIX_LENGTH)}`;
}

/**
 * Whether a presented token names a prefix some key has: one index lookup, no argon2. The
 * failed-authentication limit uses it to refuse a guess that could not possibly
 * authenticate without paying for a verification (`http/rate-limit.ts`).
 */
export async function keyPrefixExists(db: DbOrTx, presented: string | undefined): Promise<boolean> {
  if (presented === undefined || !KEY_SHAPE.test(presented)) return false;
  const [row] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.keyPrefix, keyPrefixOf(presented))).limit(1);
  return row !== undefined;
}

export async function hashApiKey(plaintext: string): Promise<string> {
  return argon2Hash(plaintext, ARGON2);
}

export async function createApiKey(db: DbOrTx, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const scopes = [...new Set(input.scopes ?? [])];
  if (input.kind === 'publishable' && scopes.length > 0) {
    throw new AuthError('invalid_input', 'a publishable key carries no scopes', { scopes });
  }
  const label = input.label ?? null;
  if (label !== null && (label.trim() === '' || label.length > 100)) {
    throw new AuthError('invalid_input', 'label must be 1 to 100 characters when given');
  }
  const plaintext = `${input.kind === 'secret' ? 'sk' : 'pk'}_${input.environment}_${randomSecret()}`;
  const keyHash = await hashApiKey(plaintext);

  return db.transaction(async (tx) => {
    const [key] = await tx
      .insert(apiKeys)
      .values({ id: newId('key'), tenantId: input.tenantId, kind: input.kind, environment: input.environment, keyPrefix: keyPrefixOf(plaintext), keyHash, scopes, label, expiresAt: input.expiresAt ?? null })
      .returning();
    if (key === undefined) throw new Error('api_keys insert returned no row');
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'api_key.created',
      subject: key.id,
      before: null,
      after: publicFields(key),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { key, plaintext };
  });
}

/** What an audit row or a console may show of a key: never the hash. */
export function publicFields(key: ApiKey): Record<string, unknown> {
  return { id: key.id, tenantId: key.tenantId, kind: key.kind, environment: key.environment, keyPrefix: key.keyPrefix, scopes: key.scopes, label: key.label, revokedAt: key.revokedAt };
}

export type RevokeApiKeyInput = { tenantId: Id<'tnt'>; keyId: string; actor: Actor; requestId?: string };

/** Revoke once; a second revocation of the same key is a no-op that returns the row. */
export async function revokeApiKey(db: DbOrTx, input: RevokeApiKeyInput): Promise<ApiKey> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(apiKeys).where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.tenantId, input.tenantId))).for('update');
    if (before === undefined) throw new AuthError('api_key_not_found', `No API key ${input.keyId}`, { keyId: input.keyId });
    if (before.revokedAt !== null) return before;
    const [after] = await tx.update(apiKeys).set({ revokedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(apiKeys.id, before.id)).returning();
    if (after === undefined) throw new Error(`api_keys update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor,
      action: 'api_key.revoked',
      subject: before.id,
      before: publicFields(before),
      after: publicFields(after),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    verifiedCache.forget(before.id);
    return after;
  });
}

export type AuthenticatedKey = {
  key: ApiKey;
  tenant: Tenant;
  /** The actor a request on this key acts as: an operator when the key carries the scope, the tenant otherwise. */
  actor: Actor;
  selfServe: boolean;
};

export function actorFor(key: ApiKey): Actor {
  return key.scopes.includes('operator') ? { kind: 'operator', ref: key.id } : { kind: 'tenant', ref: key.id };
}

/** Remembers the digest of recently verified plaintexts so a hot key is not re-hashed per request. */
class VerifiedCache {
  private readonly entries = new Map<string, { keyId: string; at: number }>();

  get(digest: string, now: number): string | undefined {
    const hit = this.entries.get(digest);
    if (hit === undefined) return undefined;
    if (now - hit.at > VERIFIED_CACHE_TTL_MS) {
      this.entries.delete(digest);
      return undefined;
    }
    return hit.keyId;
  }

  set(digest: string, keyId: string, now: number): void {
    if (this.entries.size >= VERIFIED_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(digest, { keyId, at: now });
  }

  forget(keyId: string): void {
    for (const [digest, entry] of this.entries) if (entry.keyId === keyId) this.entries.delete(digest);
  }

  clear(): void {
    this.entries.clear();
  }
}

const verifiedCache = new VerifiedCache();
const lastTouched = new Map<string, number>();

/** For tests that revoke and re-authenticate within the cache's window. */
export function resetAuthCaches(): void {
  verifiedCache.clear();
  lastTouched.clear();
}

export type AuthenticateOptions = {
  now?: Date;
};

/**
 * Resolve a presented key to its row and tenant, or throw an `AuthError`. Every refusal
 * takes the same path to the argon2 verification where a candidate exists, and the error
 * messages never say whether a prefix matched.
 */
export async function authenticateApiKey(db: DbOrTx, presented: string, options: AuthenticateOptions = {}): Promise<AuthenticatedKey> {
  const now = options.now ?? new Date();
  const match = KEY_SHAPE.exec(presented);
  if (match === null) throw new AuthError('invalid_api_key', 'Invalid API key');

  const digest = createHash('sha256').update(presented).digest('hex');
  const cached = verifiedCache.get(digest, now.getTime());
  const candidates = await db
    .select({ key: apiKeys, tenant: tenants })
    .from(apiKeys)
    .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
    .where(cached === undefined ? eq(apiKeys.keyPrefix, keyPrefixOf(presented)) : eq(apiKeys.id, cached));

  let found: { key: ApiKey; tenant: Tenant } | undefined;
  for (const candidate of candidates) {
    if (cached === candidate.key.id || (await argon2Verify(candidate.key.keyHash, presented))) {
      found = candidate;
      break;
    }
  }
  if (found === undefined) throw new AuthError('invalid_api_key', 'Invalid API key');
  if (found.key.revokedAt !== null) {
    verifiedCache.forget(found.key.id);
    throw new AuthError('api_key_revoked', 'This API key was revoked', { keyPrefix: found.key.keyPrefix, revokedAt: found.key.revokedAt.toISOString() });
  }
  const [lease] = await db.select({ expiresAt: sandboxLeases.expiresAt }).from(sandboxLeases).where(eq(sandboxLeases.tenantId, found.tenant.id));
  if ((found.key.expiresAt !== null && found.key.expiresAt <= now) || (lease !== undefined && lease.expiresAt <= now)) {
    verifiedCache.forget(found.key.id);
    throw new AuthError('api_key_expired', 'This sandbox API key has expired');
  }
  if (found.tenant.status !== 'active') {
    throw new AuthError('tenant_suspended', 'This tenant is suspended', { tenantId: found.tenant.id });
  }

  verifiedCache.set(digest, found.key.id, now.getTime());
  await touchLastUsed(db, found.key, now);
  return { key: found.key, tenant: found.tenant, actor: actorFor(found.key), selfServe: lease !== undefined };
}

/** Write `last_used_at` at most once a minute per key, remembered per process so a hot key costs no write. */
async function touchLastUsed(db: DbOrTx, key: ApiKey, now: Date): Promise<void> {
  const last = lastTouched.get(key.id) ?? key.lastUsedAt?.getTime() ?? -Infinity;
  if (now.getTime() - last < LAST_USED_WRITE_INTERVAL_MS) return;
  lastTouched.set(key.id, now.getTime());
  const threshold = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS);
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now, updatedAt: sql`now()` })
    .where(and(eq(apiKeys.id, key.id), or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, threshold))));
}

/** Every key of a tenant, hash omitted, newest first. */
export async function listApiKeys(db: DbOrTx, tenantId: Id<'tnt'>): Promise<Array<Omit<ApiKey, 'keyHash'>>> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId)).orderBy(sql`${apiKeys.createdAt} desc`);
  return rows.map(({ keyHash: _hash, ...rest }) => rest);
}
