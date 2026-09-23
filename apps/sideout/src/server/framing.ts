/**
 * The partner framing, behind one switch (`LUCRA_FRAMING`).
 *
 * Purse is a competition platform built from scratch: a ledger, a contest engine, an
 * eligibility ruleset, an embeddable SDK, a webhook dispatcher, an operator console and a
 * fiat rail. It is also, deliberately, the same *shape* as the infrastructure Lucra sells,
 * because that is the problem it was built to understand. When this framing is on, the app
 * says so plainly and maps one to the other; when it is off, every one of those screens is
 * still there and simply describes itself on its own terms.
 *
 * It is a switch rather than a rewrite because the two audiences are different. A reader
 * who has never heard of Lucra should not have to decode an extended comparison to a
 * company they do not know, and a reader who works there should not have to guess whether
 * the resemblance was on purpose.
 *
 * `LUCRA_FRAMING=off` removes the `/lucra` page from the navigation and drops the
 * comparison copy. Nothing about the platform changes: the treasury, the invariants and
 * the API are identical either way, which is the point.
 */

export type Framing = {
  enabled: boolean;
  /** The partner's name, used in body copy. */
  partner: string;
  partnerUrl: string;
};

export const PARTNER = 'Lucra';
export const PARTNER_URL = 'https://www.playlucra.com';

/** Default on: the framing is the reason the project exists, so it is opt-out rather than opt-in. */
export function lucraFraming(source: Record<string, string | undefined> = process.env): Framing {
  const raw = (source['LUCRA_FRAMING'] ?? source['NEXT_PUBLIC_LUCRA_FRAMING'] ?? 'on').trim().toLowerCase();
  const enabled = raw !== 'off' && raw !== 'false' && raw !== '0' && raw !== 'no';
  return { enabled, partner: PARTNER, partnerUrl: PARTNER_URL };
}

/**
 * How each piece of Lucra's published product maps onto a piece of Purse, and where that
 * piece lives in this repository.
 *
 * Every row names a real file. The mapping is the argument: the interesting claim is not
 * "this resembles that" but "here is the module, and here is the test that holds it to its
 * promise".
 */
export type Correspondence = {
  /** What Lucra calls it, in their words. */
  their: string;
  /** What it is here. */
  ours: string;
  where: string;
  detail: string;
};

export const CORRESPONDENCES: readonly Correspondence[] = [
  {
    their: 'One SDK, embedded in the partner app',
    ours: '@purse/sdk and a cross-origin iframe',
    where: 'packages/purse-sdk, apps/purse-embed',
    detail:
      'The partner mounts an iframe on Purse\u2019s origin and talks to it over typed postMessage with an exact origin and a nonce. The secret key never reaches a browser, and the build greps its own client bundle for one and fails if it finds it.',
  },
  {
    their: 'Merchant of record for real-money flows',
    ours: 'The treasury: custody, deposits, withdrawals, rake',
    where: 'apps/purse/src/treasury',
    detail:
      'Dollars sit in custody at a payment provider; the ledger records each player\u2019s claim in a closed-loop asset at one unit to one cent. An invariant reconciles the two every fifteen minutes and fails the health check if they diverge.',
  },
  {
    their: 'KYC and identity verification',
    ours: 'The identity seam and its state machine',
    where: 'apps/purse/src/providers, apps/purse/src/users/verification.ts',
    detail:
      'The state machine is real and enforced by a database trigger, so a user cannot jump from unstarted to verified. The check itself is an interface standing in for Persona or Socure; no document or image has anywhere to be stored.',
  },
  {
    their: 'Geolocation and state availability',
    ours: 'The geolocation seam and permitted regions',
    where: 'apps/purse/src/providers/dev/geo.ts, apps/purse/src/eligibility',
    detail:
      'Every eligibility decision records the region it was made under and the version of the ruleset in force, so an auditor can be shown which rules applied when. GeoComply is the vendor named behind the interface.',
  },
  {
    their: 'Fraud monitoring',
    ours: 'The risk seam, velocity limits and operator flags',
    where: 'apps/purse/src/providers/dev/risk.ts, apps/purse/src/eligibility/velocity.ts',
    detail:
      'Rolling stake limits and duplicate-identity fingerprints raise operator flags rather than blocking silently. Sardine is the vendor named behind the interface.',
  },
  {
    their: 'Dispute resolution and settlement',
    ours: 'Score consensus, the dispute queue and a frozen payout preview',
    where: 'apps/sideout/src/server/consensus.ts, apps/purse/src/contests/settlement.ts',
    detail:
      'The partner owns the outcome and Purse owns the settlement. A close must present the hash of the preview it was shown, and a contest whose inputs moved since then is refused rather than quietly paying something else.',
  },
  {
    their: 'Free-to-play, real money, or rewards',
    ours: 'Two assets and a per-contest rake',
    where: 'apps/purse/src/db/schema.ts, apps/purse/src/treasury/money.ts',
    detail:
      'Free-to-play contests run on POINTS with no rake. Cash contests run on the custodied asset with a rake frozen on the contest at creation, so the fee entrants agreed to cannot change underneath them.',
  },
  {
    their: 'Responsible gaming: limits and self-exclusion',
    ours: 'Restrictions honoured before entry and before money moves',
    where: 'apps/purse/src/users/restrictions.ts',
    detail:
      'A self-exclusion stops a deposit as firmly as it stops an entry. Elsewhere the platform flags rather than blocks; this is the deliberate exception, because being stopped is the thing the user asked for.',
  },
  {
    their: 'Tournaments, peer-to-peer, mini games',
    ours: 'Three contest kinds on one engine',
    where: 'apps/purse/src/contests',
    detail:
      'Tournament, head-to-head and pool share a lifecycle, an escrow model and a settlement engine. A second tenant, an office ping-pong ladder, runs on the same platform to prove the engine is not Sideout-shaped.',
  },
  {
    their: 'Operator-controlled configuration',
    ours: 'The operator console and a versioned ruleset',
    where: 'apps/purse-console, apps/purse/src/eligibility/rulesets.ts',
    detail:
      'Its own origin and its own sessions, no database access, talking to the API over the same boundary a partner does. Rulesets are versioned and pinned to every decision made under them.',
  },
];
