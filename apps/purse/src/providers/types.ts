import type { Asset, LocationSource } from '@purse/types';

import type { Ruleset } from '../eligibility/ruleset';

/**
 * The three provider seams (spec 4.5). Each is an interface Purse calls at one place, with
 * a deterministic dev implementation in `./dev`, and each stands in for a licensed vendor
 * a real platform would plug in here: Persona or Socure for identity, GeoComply for
 * geolocation, Sardine for risk. `docs/providers.md` is the table. Nothing that crosses a
 * seam is a document, an image or a raw location trace: the interfaces carry the minimum
 * a decision needs and return opaque references.
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

export type Providers = {
  identity: IdentityProvider;
  geo: GeoProvider;
  risk: RiskProvider;
};
