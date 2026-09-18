import type { PillSpec } from '@sideout/ui';
import type { VerificationState } from '@purse/types';

import type { ConsensusState, DonationStatus, MatchStatus, PurseCallStatus, TeamStatus, TournamentStatus } from '../../db/schema';

/**
 * Every status enum as a pill: a label plus an icon, so colour is never the only carrier
 * of meaning (spec 6.1). `live` and `success` are surf, `attention` is fault; ember is the
 * charity colour and appears on no pill.
 */
export const TOURNAMENT_STATUS_PILL: Record<TournamentStatus, PillSpec> = {
  draft: { label: 'Draft', tone: 'muted', icon: 'circleDashed' },
  registration_open: { label: 'Registration open', tone: 'neutral', icon: 'users' },
  registration_closed: { label: 'Registration closed', tone: 'muted', icon: 'ban' },
  live: { label: 'Live', tone: 'live', icon: 'radio' },
  awaiting_settlement: { label: 'Awaiting settlement', tone: 'attention', icon: 'hourglass' },
  settled: { label: 'Settled', tone: 'muted', icon: 'circleCheck' },
  cancelled: { label: 'Cancelled', tone: 'muted', icon: 'x' },
};

export const MATCH_STATUS_PILL: Record<MatchStatus, PillSpec> = {
  scheduled: { label: 'Scheduled', tone: 'muted', icon: 'clock' },
  in_progress: { label: 'In progress', tone: 'live', icon: 'activity' },
  awaiting_scores: { label: 'Awaiting scores', tone: 'neutral', icon: 'hourglass' },
  disputed: { label: 'Disputed', tone: 'attention', icon: 'triangleAlert' },
  final: { label: 'Final', tone: 'muted', icon: 'check' },
  forfeited: { label: 'Forfeit', tone: 'muted', icon: 'ban' },
  bye: { label: 'Bye', tone: 'muted', icon: 'arrowRight' },
};

export const CONSENSUS_STATE_PILL: Record<ConsensusState, PillSpec> = {
  awaiting_first: { label: 'No scores yet', tone: 'muted', icon: 'circleDashed' },
  awaiting_second: { label: 'Waiting on opponent', tone: 'neutral', icon: 'hourglass' },
  agreed: { label: 'Agreed', tone: 'success', icon: 'circleCheck' },
  disputed: { label: 'Disputed', tone: 'attention', icon: 'triangleAlert' },
  pushed_to_purse: { label: 'Sent to Purse', tone: 'success', icon: 'check' },
  confirmed: { label: 'Confirmed', tone: 'success', icon: 'shieldCheck' },
};

export const TEAM_STATUS_PILL: Record<TeamStatus, PillSpec> = {
  forming: { label: 'Forming', tone: 'neutral', icon: 'circleDashed' },
  registered: { label: 'Registered', tone: 'success', icon: 'circleCheck' },
  checked_in: { label: 'Checked in', tone: 'success', icon: 'check' },
  withdrawn: { label: 'Withdrawn', tone: 'muted', icon: 'ban' },
};

/** Donation state, worded as a gift: ember is reserved for charity figures, so these stay on the neutral tones. */
export const DONATION_STATUS_PILL: Record<DonationStatus, PillSpec> = {
  pending: { label: 'Processing', tone: 'neutral', icon: 'hourglass' },
  succeeded: { label: 'Received', tone: 'success', icon: 'circleCheck' },
  refunded: { label: 'Refunded', tone: 'muted', icon: 'ban' },
  failed: { label: 'Failed', tone: 'attention', icon: 'circleAlert' },
};

/** Purse's verification states (spec 4.5). `rejected` is terminal (spec 5.3). */
export const VERIFICATION_STATE_PILL: Record<VerificationState, PillSpec> = {
  unstarted: { label: 'Not verified', tone: 'muted', icon: 'circleDashed' },
  pending: { label: 'Under review', tone: 'neutral', icon: 'hourglass' },
  verified: { label: 'Verified', tone: 'success', icon: 'circleCheck' },
  rejected: { label: 'Not allowed', tone: 'attention', icon: 'ban' },
};

export const PURSE_CALL_STATUS_PILL: Record<PurseCallStatus, PillSpec> = {
  in_flight: { label: 'In flight', tone: 'neutral', icon: 'hourglass' },
  succeeded: { label: 'Succeeded', tone: 'success', icon: 'check' },
  refused: { label: 'Refused', tone: 'attention', icon: 'circleAlert' },
  failed: { label: 'Failed', tone: 'attention', icon: 'x' },
};
