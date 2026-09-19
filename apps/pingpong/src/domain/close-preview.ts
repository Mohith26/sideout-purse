import type { PayoutResource, PreviewEntryResource } from '@purse/types';

/**
 * The frozen settlement preview the close screen shows and the close confirms against
 * (spec 4.7, "frozen preview"): Purse's preview (entries, payouts, the payout hash) as it
 * was fetched, with the ladder it was checked against. Stored on the season by
 * `previewClose`; `closeSeason` refuses a hash that is not this one, and Purse refuses one
 * whose recomputation differs.
 */
export type FrozenClosePreview = {
  version: 1;
  contestId: string;
  payoutHash: string;
  escrowTotal: string;
  entries: PreviewEntryResource[];
  payouts: PayoutResource[];
  /** The ladder at the freeze: player ids by rank, with the final score each was pushed with. */
  standings: Array<{ playerId: string; purseUserId: string; rank: number; wins: number; losses: number; score: number }>;
  contestState: string;
  previewedAt: string;
  previewedByPlayerId: string;
};

/** What Purse settled, kept verbatim on the closed season. */
export type SeasonSettlement = {
  contestId: string;
  payoutHash: string;
  journalEntryId: string | null;
  settledAt: string | null;
  results: Array<{ userId: string; placement: number; score: number | null; payoutAmount: string }>;
  replayed: boolean;
};

/** A stored preview is usable only while the hash it froze is what the commissioner confirms with. */
export function previewMatches(frozen: FrozenClosePreview | null, payoutHash: string): frozen is FrozenClosePreview {
  return frozen !== null && frozen.payoutHash === payoutHash;
}
