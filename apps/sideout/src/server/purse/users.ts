import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { EmbedFlow } from '@purse/types';

import type { ParsedUser as UserResource, ParsedWallet as WalletResource } from '../../purse/schemas';

import { users, type User } from '../../db/schema';
import { PURSE_ASSET, PURSE_WELCOME_POINTS } from '../../domain/purse-score';
import { PurseApiError } from '../../purse';
import { actorFor } from '../actor';
import { writeAudit } from '../audit';
import { failure } from '../http/errors';
import { idempotencyKey, type PurseDeps } from './deps';

/**
 * The user side of the boundary (decision D8): Sideout authenticates its own users, then
 * links each to a Purse user by the opaque `purse_external_id` it minted. Linking is an
 * upsert Purse keys by external id, so it is safe to repeat; the Purse user id comes back
 * and is stored, and what Purse says about the user (verification, wallet) is mirrored
 * for the profile and read back live on request.
 */

export type PurseProfile = {
  linked: boolean;
  verification: UserResource['verification'] | null;
  restrictions: UserResource['restrictions'];
  wallet: WalletResource['balances'];
  displayName: string | null;
};

function bodyHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Create or refresh the Purse user for a Sideout user and record the link. On the first
 * link the welcome grant of POINTS is issued (operator scope on the key) under a fixed
 * key, so a second link never issues it twice.
 */
export async function linkPurseUser(deps: PurseDeps, input: { user: User; requestId: string; now: Date }): Promise<PurseProfile> {
  const { user, requestId, now } = input;
  const body = { externalId: user.purseExternalId, displayName: user.displayName, ...(user.phoneE164 === null ? {} : { phoneE164: user.phoneE164 }) };
  const subject = { type: 'user' as const, id: user.id };
  const upserted = await deps.purse.upsertUser(body, { requestId, idempotencyKey: idempotencyKey('sideout', 'user', user.id, 'upsert', bodyHash(body)), subject });
  const purseUser = upserted.data;

  const alreadyLinked = user.purseUserId === purseUser.id;
  await deps.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ purseUserId: purseUser.id, purseLinkedAt: user.purseLinkedAt ?? now, purseVerificationState: purseUser.verification.state, updatedAt: now })
      .where(eq(users.id, user.id));
    if (!alreadyLinked) {
      await writeAudit(tx, {
        actor: actorFor(user),
        action: 'user.purse_linked',
        subjectType: 'user',
        subjectId: user.id,
        detail: { created: upserted.status === 201, verification: purseUser.verification.state },
        at: now,
      });
    }
  });

  // The welcome grant: POINTS are the free-to-play asset, issued by the platform so a
  // free entry is affordable. One fixed key per user, so a replay issues nothing new.
  await deps.purse.issueCredits(
    purseUser.id,
    { asset: PURSE_ASSET, amount: PURSE_WELCOME_POINTS, description: 'Sideout welcome points' },
    { requestId, idempotencyKey: idempotencyKey('sideout', 'user', user.id, 'welcome-points', 'v1'), subject },
  );

  // The wallet is read back for the answer and never stored: contest value lives in Purse.
  const wallet = await deps.purse.getWallet(purseUser.id, { requestId, subject });
  return { linked: true, verification: purseUser.verification, restrictions: purseUser.restrictions, wallet: wallet.data.balances, displayName: purseUser.displayName };
}

/** The profile as Purse holds it right now; an unlinked user gets `linked: false` and no call is made. */
export async function readPurseProfile(deps: PurseDeps, input: { user: User; requestId: string; now: Date }): Promise<PurseProfile> {
  const { user, requestId, now } = input;
  if (user.purseUserId === null) return { linked: false, verification: null, restrictions: [], wallet: [], displayName: null };
  const subject = { type: 'user' as const, id: user.id };
  const [profile, wallet] = await Promise.all([deps.purse.getUser(user.purseUserId, { requestId, subject }), deps.purse.getWallet(user.purseUserId, { requestId, subject })]);
  await deps.db.update(users).set({ purseVerificationState: profile.data.verification.state, updatedAt: now }).where(eq(users.id, user.id));
  return { linked: true, verification: profile.data.verification, restrictions: profile.data.restrictions, wallet: wallet.data.balances, displayName: profile.data.displayName };
}

export type EmbedTokenGrant = { token: string; expiresAt: string; flow: EmbedFlow; purseOrigin: string; publishableKey: string; tenantId: string };

/**
 * A single-use embed token for one of the signed-in player's flows, minted server to
 * server and handed to the browser, where the SDK opens the flow with it (spec 4.8 rule
 * 5). Every mint is a fresh key: a replay of an earlier mint would return `token: null`.
 */
export async function mintEmbedToken(deps: PurseDeps, input: { user: User; flow: EmbedFlow; requestId: string; nonce: string }): Promise<EmbedTokenGrant> {
  const { user, flow, requestId } = input;
  if (user.purseUserId === null) throw failure.invalidState('purse_not_linked', 'Link your Purse account first (POST /api/me/purse/link).');
  if (deps.env.publishableKey === undefined) throw failure.internal('purse_publishable_key_missing', 'The Purse publishable key is not configured on this server.').withStatus(503);
  let minted;
  try {
    minted = await deps.purse.mintEmbedToken({ userId: user.purseUserId, flow }, { requestId, idempotencyKey: idempotencyKey('sideout', 'embed', user.id, flow, input.nonce), subject: { type: 'user', id: user.id } });
  } catch (error) {
    if (error instanceof PurseApiError && error.type === 'invalid_request') throw failure.invalidState('purse_user_unknown', 'Purse no longer knows this user; link again.', error.toJSON());
    throw error;
  }
  if (minted.data.token === null) throw failure.internal('embed_token_replayed', 'Purse replayed an earlier token instead of minting one; try again.');
  return { token: minted.data.token, expiresAt: minted.data.expiresAt, flow, purseOrigin: deps.env.browserOrigin, publishableKey: deps.env.publishableKey, tenantId: deps.env.tenantId };
}
