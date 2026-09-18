import type { EligibilityDecision } from './eligibility';

/**
 * The resources the v1 API returns (system spec 4.7), as they appear on the wire. This is
 * the contract `@purse/sdk` (phase 4) types its responses with, so it lives here and not in
 * the API. Every value is JSON: money is a decimal string of minor units (never a number,
 * which would lose precision past 2^53), instants are ISO 8601 strings, and ids carry
 * their typed prefix.
 */

/** Minor units as a decimal string, `"1000"`. Parse with `BigInt`, never `Number`. */
export type Money = string;

export const ASSETS = ['POINTS', 'CREDIT'] as const;
export type Asset = (typeof ASSETS)[number];

export const CONTEST_KINDS = ['tournament', 'head_to_head', 'pool'] as const;
export type ContestKind = (typeof CONTEST_KINDS)[number];

export const CONTEST_STATES = ['draft', 'open', 'locked', 'in_progress', 'awaiting_settlement', 'settling', 'settled', 'cancelled', 'voided'] as const;
export type ContestState = (typeof CONTEST_STATES)[number];

export const SETTLEMENT_POLICIES = ['operator_close', 'auto'] as const;
export type SettlementPolicy = (typeof SETTLEMENT_POLICIES)[number];

export const TIE_BREAK_RULES = ['split_evenly', 'higher_seed_wins', 'earliest_submission_wins'] as const;
export type TieBreakRule = (typeof TIE_BREAK_RULES)[number];

export const PARTICIPANT_STATES = ['entered', 'withdrawn', 'disqualified'] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export const VERIFICATION_STATES = ['unstarted', 'pending', 'verified', 'rejected'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const RESTRICTION_KINDS = ['self_exclusion', 'cool_off', 'platform_block', 'velocity_lock'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export const LOCATION_SOURCES = ['ip', 'declared', 'provider'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/** The iframe flows an embed token may open (spec 4.8). */
export const EMBED_FLOWS = ['identity', 'wallet', 'entry', 'rewards'] as const;
export type EmbedFlow = (typeof EMBED_FLOWS)[number];

export const API_KEY_KINDS = ['secret', 'publishable'] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

export const API_KEY_ENVIRONMENTS = ['sandbox', 'live'] as const;
export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

/**
 * A prize structure as it appears in JSON (spec 4.4, decision D10). The API validates it
 * with the settlement engine's own schema; this is the same shape written down as a type.
 */
export type PrizeStructure =
  | { type: 'winner_take_all'; participationFloor?: Money }
  | { type: 'placement_table'; placements: Array<{ placement: number; amount: Money }> | Array<{ placement: number; percent: number }>; participationFloor?: Money }
  | { type: 'percentage_split'; percentages: number[]; participationFloor?: Money }
  | { type: 'top_n_equal'; n: number; participationFloor?: Money }
  | { type: 'guaranteed_minimum'; minimums: Money[]; percentages: number[]; participationFloor?: Money };

export type VerificationResource = {
  state: VerificationState;
  provider: string | null;
  verifiedAt: string | null;
  reverifyAfter: string | null;
};

export type RestrictionResource = {
  id: string;
  kind: RestrictionKind;
  /** Present for the kinds a user places on themself (`self_exclusion`, `cool_off`); an operator's or the platform's reason is not shared. */
  reason?: string | null;
  startsAt: string;
  endsAt: string | null;
};

export type LocationResource = {
  regionCode: string;
  source: LocationSource;
  resolvedAt: string;
  /** 0 to 1. */
  confidence: number;
};

export type UserResource = {
  id: string;
  externalId: string;
  displayName: string | null;
  phoneE164: string | null;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string | null;
  verification: VerificationResource;
  /** Restrictions in force now. */
  restrictions: RestrictionResource[];
  location: LocationResource | null;
  createdAt: string;
  updatedAt: string;
};

export type WalletBalanceResource = { asset: Asset; balance: Money; accountId: string | null };

export type WalletResource = { userId: string; balances: WalletBalanceResource[] };

export type CreditResource = {
  userId: string;
  asset: Asset;
  amount: Money;
  journalEntryId: string;
  /** The wallet balance after the credit. */
  balance: Money;
};

export type EmbedTokenResource = {
  token: string;
  flow: EmbedFlow;
  userId: string;
  expiresAt: string;
};

export type VerificationStartResource = {
  user: UserResource;
  verification: VerificationResource;
  embedToken: EmbedTokenResource;
};

export type ContestResource = {
  id: string;
  externalId: string;
  kind: ContestKind;
  title: string;
  asset: Asset;
  entryAmount: Money;
  maxParticipants: number | null;
  prizeStructure: PrizeStructure;
  tieBreak: TieBreakRule;
  settlementPolicy: SettlementPolicy;
  eligibilityRulesetVersion: string | null;
  state: ContestState;
  opensAt: string | null;
  locksAt: string | null;
  escrowAccountId: string;
  escrowBalance: Money;
  /** Entrants whose stake is in escrow (entered or disqualified). */
  participantCount: number;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ParticipantResource = {
  id: string;
  contestId: string;
  userId: string;
  teamRef: string | null;
  seed: number | null;
  state: ParticipantState;
  joinedAt: string;
  entryJournalEntryId: string;
};

export type EntryResource = {
  contest: ContestResource;
  participant: ParticipantResource;
  eligibility: EligibilityDecision;
  journalEntryId: string;
};

export type WithdrawalResource = {
  contest: ContestResource;
  participant: ParticipantResource;
  refundJournalEntryId: string;
};

export type ScoreResource = {
  id: string;
  contestId: string;
  userId: string;
  score: number | null;
  attemptFinished: boolean;
  submittedAt: string;
  sourceRef: string | null;
};

export type ResultResource = {
  id: string;
  contestId: string;
  userId: string;
  placement: number;
  score: number | null;
  payoutAmount: Money;
  payoutJournalEntryId: string | null;
  computedAt: string;
};

export type SettlementResource = {
  contest: ContestResource;
  results: ResultResource[];
  payoutHash: string;
  /** The one `settle` journal entry, or `null` when nothing was owed. */
  journalEntryId: string | null;
};

export type ScoresResource = {
  contest: ContestResource;
  scores: ScoreResource[];
  /** Present when this batch completed an `auto` contest and settled it. */
  settlement: SettlementResource | null;
};

export type PayoutResource = { userId: string; placement: number; payout: Money };

export type PreviewEntryResource = {
  userId: string;
  participantId: string;
  participantState: ParticipantState;
  score: number | null;
  seed: number | null;
  attemptFinished: boolean;
};

export type PreviewResource = {
  contestId: string;
  state: ContestState;
  escrowTotal: Money;
  entries: PreviewEntryResource[];
  payouts: PayoutResource[];
  /** Pass this to `POST /contests/:id/close`; the close is refused if the recomputation differs. */
  payoutHash: string;
};

export type ResultsResource = {
  contestId: string;
  state: ContestState;
  settledAt: string | null;
  results: ResultResource[];
};

export type VoidResource = {
  contest: ContestResource;
  refundJournalEntryIds: string[];
};
