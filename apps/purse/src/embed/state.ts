import { and, desc, eq } from 'drizzle-orm';
import type { EmbedUser, EmbedUserState, WalletBalanceResource } from '@purse/types';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { asset as assetEnum, contestResults, contests } from '../db/schema';
import { findAccount } from '../ledger/accounts';
import { balanceOf } from '../ledger/balance';
import { loadProfile, placedByUser } from '../users';

/**
 * What the embed shows and `getUserState()` returns (spec 4.8): the user's verification
 * state, the restrictions in force and the wallet by asset. Phone number and date of
 * birth stay out: the partner already has them and the frame does not need them.
 */
export async function embedUserState(db: DbOrTx, tenantId: Id<'tnt'>, userId: string): Promise<EmbedUserState> {
  const profile = await loadProfile(db, tenantId, userId);
  const wallet: WalletBalanceResource[] = [];
  for (const asset of assetEnum.enumValues) {
    const account = await findAccount(db, { tenantId, kind: 'user_wallet', ownerRef: profile.user.id, asset });
    wallet.push({ asset, balance: account === undefined ? '0' : (await balanceOf(db, account.id)).toString(), accountId: account?.id ?? null });
  }
  const user: EmbedUser = {
    id: profile.user.id,
    externalId: profile.user.externalId,
    displayName: profile.user.displayName,
    verification: {
      state: profile.verification.state,
      provider: profile.verification.provider,
      verifiedAt: profile.verification.verifiedAt?.toISOString() ?? null,
      reverifyAfter: profile.verification.reverifyAfter?.toISOString() ?? null,
    },
    restrictions: profile.restrictions.map((restriction) => ({
      id: restriction.id,
      kind: restriction.kind,
      ...(placedByUser(restriction) ? { reason: restriction.reason } : {}),
      startsAt: restriction.startsAt.toISOString(),
      endsAt: restriction.endsAt?.toISOString() ?? null,
    })),
    wallet,
  };
  return { authenticated: true, user };
}

export type RewardRow = {
  contestId: string;
  externalId: string;
  title: string;
  asset: string;
  placement: number;
  score: string | null;
  payoutAmount: string;
  computedAt: string;
};

/** The user's settled results, newest first: the rewards flow's list. */
export async function rewardsOf(db: DbOrTx, tenantId: Id<'tnt'>, userId: string, limit = 50): Promise<RewardRow[]> {
  const rows = await db
    .select({ result: contestResults, contest: contests })
    .from(contestResults)
    .innerJoin(contests, eq(contests.id, contestResults.contestId))
    .where(and(eq(contestResults.userId, userId), eq(contests.tenantId, tenantId)))
    .orderBy(desc(contestResults.computedAt))
    .limit(limit);
  return rows.map(({ result, contest }) => ({
    contestId: contest.id,
    externalId: contest.externalId,
    title: contest.title,
    asset: contest.asset,
    placement: result.placement,
    score: result.score === null ? null : String(result.score),
    payoutAmount: result.payoutAmount.toString(),
    computedAt: result.computedAt.toISOString(),
  }));
}
