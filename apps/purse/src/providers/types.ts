import type { Asset, LocationSource } from '@purse/types';

import type { Ruleset } from '../eligibility/ruleset';

/**
 * The four provider seams (spec 4.5, 13.1). Each is an interface Purse calls at one place,
 * with a deterministic dev implementation in `./dev`, and each stands in for a licensed
 * vendor a real platform would plug in here: Persona or Socure for identity, GeoComply for
 * geolocation, Sardine for risk, Stripe or Checkout.com for funding. `docs/providers.md`
 * is the table. Nothing that crosses a seam is a document, an image or a raw location
 * trace: the interfaces carry the minimum a decision needs and return opaque references.
 */

// ---- Identity ------------------------------------------------------------------------

/** What an identity provider is told about a user: the demographics the partner supplied, never a document. */
export type IdentityCheckRequest = {
  userId: string;
  tenantId: string;
  externalId: string;
  displayName: string | null;
  dateOfBirth: string | null;
  phoneE164: string | null;
};

export type VerificationOutcome = 'verified' | 'rejected' | 'pending';

export type VerificationResult = {
  outcome: VerificationOutcome;
  /** The provider's opaque reference for the check (an inquiry id), short and token-shaped; never a document. */
  providerRef: string;
  /** When a verified user should verify again; the service applies a default when absent. */
  reverifyAfter?: Date;
  /** Why, for the audit log. Presentation copy, not a contract. */
  note?: string;
};

export type IdentityProvider = {
  /** Stored as `user_verification.provider`; lower-case, token-shaped. */
  readonly name: string;
  verify(user: IdentityCheckRequest): Promise<VerificationResult>;
};

// ---- Geolocation ---------------------------------------------------------------------

/** What a geolocation provider gets: what the partner declared, and the end user's address as the partner saw it. */
export type GeoRequest = {
  declaredRegion?: string | null;
  ip?: string | null;
};

export type GeoResolution = {
  /** ISO 3166 code (`US-TX`), or `null` when the request cannot be placed. */
  region: string | null;
  /** 0 to 1. */
  confidence: number;
  source: LocationSource;
};

export type GeoProvider = {
  readonly name: string;
  resolve(request: GeoRequest): Promise<GeoResolution>;
};

// ---- Risk ----------------------------------------------------------------------------

/** The transaction a risk provider assesses: an entry, with what the platform already knows about the user. */
export type RiskTransaction = {
  tenantId: string;
  userId: string;
  contestId: string;
  asset: Asset;
  amount: bigint;
  velocity: { enteredLast24h: bigint; enteredLast7d: bigint };
  /** Kinds of operator flags currently open on this user. */
  openFlags: string[];
  /** How long the user has existed, in milliseconds. */
  accountAgeMs: number;
  ruleset: Ruleset;
};

export type RiskSignal = {
  code: string;
  detail?: Record<string, string | number | boolean | null>;
};

export type RiskDecision = 'allow' | 'review' | 'deny';

export type RiskAssessment = {
  decision: RiskDecision;
  signals: RiskSignal[];
};

export type RiskProvider = {
  readonly name: string;
  assess(transaction: RiskTransaction): Promise<RiskAssessment>;
};

// ---- Funding -------------------------------------------------------------------------

/**
 * The fiat rail (spec 13.1). This is the only seam that moves real currency, and it is
 * the reason no `USD` account exists in the ledger: dollars live at the provider and at
 * the bank behind it, and Purse records a claim on them in `CREDIT`.
 *
 * A provider is told an amount in US cents, a stored instrument token and an idempotency
 * key, and answers with what the rail did. It is never told, and can never be told, a card
 * number: the instrument is already a token by the time it reaches here, which is what
 * keeps this database out of PCI scope.
 */
export type FundingInstrument = {
  paymentMethodId: string;
  /** The provider's token for the stored instrument. */
  providerRef: string;
  brand: string;
  last4: string;
};

export type ChargeRequest = {
  tenantId: string;
  userId: string;
  /** US cents, strictly positive. */
  amountUsdCents: bigint;
  instrument: FundingInstrument;
  /** Passed through to the rail so a retry cannot double-charge. */
  idempotencyKey: string;
  statementDescriptor: string;
};

export type PayoutRequest = {
  tenantId: string;
  userId: string;
  amountUsdCents: bigint;
  instrument: FundingInstrument;
  idempotencyKey: string;
};

/** What a rail answers. `pending` means the movement was accepted but is not final yet. */
export type FundingOutcome = 'succeeded' | 'pending' | 'declined';

export type FundingResult = {
  outcome: FundingOutcome;
  /** The provider's opaque reference for the movement. */
  providerRef: string;
  /** What the rail charged the platform to move it, in US cents. Never taken from the user. */
  feeUsdCents: bigint;
  /** Set only when `declined`; a stable, lower-case code the API can surface verbatim. */
  declineCode?: string;
  /** Presentation copy for a receipt or an operator queue, not a contract. */
  note?: string;
};

/** What a rail will accept, so the API can refuse an instrument before taking a payment. */
export type FundingCapabilities = {
  /** Instrument families the rail accepts, lower-case brand names. */
  brands: readonly string[];
  minimumDepositUsdCents: bigint;
  maximumDepositUsdCents: bigint;
  minimumWithdrawalUsdCents: bigint;
  /** How long a withdrawal takes to reach the user once approved, for the receipt copy. */
  withdrawalSettlementHours: number;
};

export type FundingProvider = {
  readonly name: string;
  readonly capabilities: FundingCapabilities;
  /** Pull money in. A deposit. */
  charge(request: ChargeRequest): Promise<FundingResult>;
  /** Push money out. A withdrawal. */
  payout(request: PayoutRequest): Promise<FundingResult>;
};

export type Providers = {
  identity: IdentityProvider;
  geo: GeoProvider;
  risk: RiskProvider;
  funding: FundingProvider;
};
