import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { EmbedFlow } from '@purse/types';

import { players, type Player } from '../../db/schema';
import { PURSE_ASSET, WELCOME_POINTS } from '../../domain/ladder';
import { PurseApiError, type ParsedUser, type ParsedWallet } from '../../purse';
import { failure } from '../http/errors';
import { idempotencyKey, type PurseDeps } from './deps';

/**
 * The user side of the boundary (decision D8): the ladder authenticates its own players,
 * then links each to a Purse user by the opaque `purse_external_id` it minted. Linking is
 * an upsert Purse keys by external id, so it is safe to repeat; the Purse user id comes
 * back and is stored. On the first link the welcome grant of POINTS is issued (operator
 * scope on the key) under a fixed key, so a second link never issues it twice. The wallet
 * is read back for the answer and never stored: contest value lives in Purse.
 */
export type PurseProfile = {
  linked: boolean;
  verification: ParsedUser['verification'] | null;
  wallet: ParsedWallet['balances'];
};

function bodyHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export async function linkPurseUser(deps: PurseDeps, input: { player: Player; requestId: string; now: Date }): Promise<PurseProfile> {
  const { player, requestId, now } = input;
  const body = { externalId: player.purseExternalId, displayName: player.name };
  const subject = { type: 'player' as const, id: player.id };
  const upserted = await deps.purse.upsertUser(body, { requestId, idempotencyKey: idempotencyKey('pingpong', 'player', player.id, 'upsert', bodyHash(body)), subject });
  const purseUser = upserted.data;
  await deps.db.update(players).set({ purseUserId: purseUser.id, purseLinkedAt: player.purseLinkedAt ?? now, updatedAt: now }).where(eq(players.id, player.id));
  await deps.purse.issueCredits(
    purseUser.id,
    { asset: PURSE_ASSET, amount: WELCOME_POINTS, description: 'Ping-pong welcome points' },
    { requestId, idempotencyKey: idempotencyKey('pingpong', 'player', player.id, 'welcome-points', 'v1'), subject },
  );
  const wallet = await deps.purse.getWallet(purseUser.id, { requestId, subject });
  return { linked: true, verification: purseUser.verification, wallet: wallet.data.balances };
}

/** The profile as Purse holds it right now; an unlinked player gets `linked: false` and no call is made. */
export async function readPurseProfile(deps: PurseDeps, input: { player: Player; requestId: string }): Promise<PurseProfile> {
  const { player, requestId } = input;
  if (player.purseUserId === null) return { linked: false, verification: null, wallet: [] };
  const subject = { type: 'player' as const, id: player.id };
  const [profile, wallet] = await Promise.all([deps.purse.getUser(player.purseUserId, { requestId, subject }), deps.purse.getWallet(player.purseUserId, { requestId, subject })]);
  return { linked: true, verification: profile.data.verification, wallet: wallet.data.balances };
}

export type EmbedTokenGrant = { token: string; expiresAt: string; flow: EmbedFlow; purseOrigin: string; publishableKey: string; tenantId: string };

/**
 * A single-use embed token for one of the signed-in player's flows, minted server to
 * server and handed to the browser, where the SDK opens the flow with it (spec 4.8 rule
 * 5). Every mint is a fresh key: a replay of an earlier mint would return `token: null`.
 */
export async function mintEmbedToken(deps: PurseDeps, input: { player: Player; flow: EmbedFlow; requestId: string; nonce: string }): Promise<EmbedTokenGrant> {
  const { player, flow, requestId } = input;
  if (player.purseUserId === null) throw failure.invalidState('purse_not_linked', 'Link your Purse account first (POST /api/me/purse/link).');
  if (deps.env.publishableKey === undefined) throw failure.internal('purse_publishable_key_missing', 'The Purse publishable key is not configured on this server.').withStatus(503);
  let minted;
  try {
    minted = await deps.purse.mintEmbedToken({ userId: player.purseUserId, flow }, { requestId, idempotencyKey: idempotencyKey('pingpong', 'embed', player.id, flow, input.nonce), subject: { type: 'player', id: player.id } });
  } catch (error) {
    if (error instanceof PurseApiError && error.type === 'invalid_request') throw failure.invalidState('purse_user_unknown', 'Purse no longer knows this player; link again.', error.toJSON());
    throw error;
  }
  if (minted.data.token === null) throw failure.internal('embed_token_replayed', 'Purse replayed an earlier token instead of minting one; try again.');
  return { token: minted.data.token, expiresAt: minted.data.expiresAt, flow, purseOrigin: deps.env.browserOrigin, publishableKey: deps.env.publishableKey, tenantId: deps.env.tenantId };
}
