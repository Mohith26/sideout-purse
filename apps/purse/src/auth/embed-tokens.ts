import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { EmbedFlow } from '@purse/types';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { embedTokens, type EmbedToken } from '../db/schema';
import { AuthError } from './errors';

/**
 * Embed tokens (spec 4.8 rule 5): single-use, scoped to one user and one flow, five-minute
 * expiry. The token is 32 random bytes, base64url, prefixed so it is recognisable in a log
 * (`embt_`); only its SHA-256 is stored. Phase 4's iframe bootstrap consumes it with
 * `consumeEmbedToken`, whose one conditional update is what makes "single use" hold when
 * two frames race for the same token.
 */
export const EMBED_TOKEN_TTL_MS = 5 * 60_000;
export const EMBED_TOKEN_PREFIX = 'embt_';
const EMBED_TOKEN_SHAPE = /^embt_[A-Za-z0-9_-]{43}$/;

export type IssueEmbedTokenInput = {
  tenantId: Id<'tnt'>;
  userId: string;
  flow: EmbedFlow;
  /** Defaults to now; the expiry is `ttlMs` after it. */
  now?: Date;
  ttlMs?: number;
};

export type IssuedEmbedToken = {
  /** The plaintext, returned exactly once. */
  token: string;
  row: EmbedToken;
};

export function hashEmbedToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueEmbedToken(db: DbOrTx, input: IssueEmbedTokenInput): Promise<IssuedEmbedToken> {
  const now = input.now ?? new Date();
  const ttl = input.ttlMs ?? EMBED_TOKEN_TTL_MS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > EMBED_TOKEN_TTL_MS) {
    throw new AuthError('invalid_input', `an embed token lives at most ${EMBED_TOKEN_TTL_MS} ms`, { ttlMs: ttl });
  }
  const token = `${EMBED_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const [row] = await db
    .insert(embedTokens)
    .values({
      id: newId('emb'),
      tenantId: input.tenantId,
      userId: input.userId,
      flow: input.flow,
      tokenHash: hashEmbedToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl),
    })
    .returning();
  if (row === undefined) throw new Error('embed_tokens insert returned no row');
  return { token, row };
}

export type ConsumeEmbedTokenInput = {
  token: string;
  /** When given, a token minted for another flow is refused. */
  flow?: EmbedFlow;
  now?: Date;
};

/**
 * Redeem a token: exactly one caller ever succeeds. An unknown token, an expired one and a
 * used one are told apart in the error code, but the messages give nothing away about
 * which tokens exist.
 */
export async function consumeEmbedToken(db: DbOrTx, input: ConsumeEmbedTokenInput): Promise<EmbedToken> {
  const now = input.now ?? new Date();
  if (typeof input.token !== 'string' || !EMBED_TOKEN_SHAPE.test(input.token)) {
    throw new AuthError('embed_token_invalid', 'The embed token is not valid');
  }
  const hash = hashEmbedToken(input.token);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(embedTokens).where(eq(embedTokens.tokenHash, hash)).for('update');
    if (existing === undefined) throw new AuthError('embed_token_invalid', 'The embed token is not valid');
    if (existing.consumedAt !== null) throw new AuthError('embed_token_used', 'The embed token was already used', { tokenId: existing.id });
    if (existing.expiresAt.getTime() <= now.getTime()) throw new AuthError('embed_token_expired', 'The embed token has expired', { tokenId: existing.id });
    if (input.flow !== undefined && existing.flow !== input.flow) {
      throw new AuthError('embed_token_wrong_flow', `The embed token opens the ${existing.flow} flow, not ${input.flow}`, { tokenId: existing.id, flow: existing.flow });
    }
    const [consumed] = await tx
      .update(embedTokens)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(and(eq(embedTokens.id, existing.id), isNull(embedTokens.consumedAt)))
      .returning();
    if (consumed === undefined) throw new AuthError('embed_token_used', 'The embed token was already used', { tokenId: existing.id });
    return consumed;
  });
}
