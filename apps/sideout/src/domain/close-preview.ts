import type { PayoutResource, PreviewEntryResource } from '@purse/types';

import type { FinalPlacement } from './final-standings';

/**
 * The frozen settlement preview the close page shows and the close confirms against
 * (spec 4.7, "frozen preview"): Purse's preview (entries, payouts, the payout hash) as it
 * was fetched, together with the Sideout standings it was checked against. Stored on the
 * tournament by `previewClose`; `closeTournament` refuses a hash that is not this one, and
 * Purse refuses one whose recomputation differs.
 */
export type FrozenClosePreview = {
  version: 1;
  contestId: string;
  payoutHash: string;
  escrowTotal: string;
  entries: PreviewEntryResource[];
  payouts: PayoutResource[];
  standings: FinalPlacement[];
  /** Purse's contest state when the preview was taken. */
  contestState: string;
  previewedAt: string;
  previewedByUserId: string;
};

/** A stored preview is usable only while the hash it froze is what the organizer confirms with. */
export function previewMatches(frozen: FrozenClosePreview | null, payoutHash: string): frozen is FrozenClosePreview {
  return frozen !== null && frozen.payoutHash === payoutHash;
}
