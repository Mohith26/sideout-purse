import { createHash } from 'node:crypto';

import type { ChargeRequest, FundingCapabilities, FundingProvider, FundingResult, PayoutRequest } from '../types';

/**
 * The dev funding provider: a deterministic stand-in for the fiat rail (spec 13.1). This
 * is where Stripe, Adyen or Checkout.com would plug in, with Purse as merchant of record
 * behind them.
 *
 * Deterministic, because a demo that declines at random is a demo nobody trusts. Every
 * answer is a pure function of the idempotency key, so the same request always gets the
 * same outcome and a walkthrough can be rehearsed. The `SCRIPTED_` tables below make the
 * interesting paths reachable on purpose rather than by waiting for luck.
 *
 * What it models that a naive stub does not:
 *
 *   - **Interchange.** A real card charge costs the platform money. The fee is the
 *     published US card-present-absent shape, 2.9% plus 30 cents, and a bank debit is a
 *     flat 80 cents, which is why the treasury page can show a real cost line.
 *   - **Declines happen at the rail, not at the app.** A decline arrives after the
 *     payment row exists, which is exactly why the payment state machine has a `failed`
 *     state rather than the service simply refusing.
 *   - **Pushing money out is slower than pulling it in.** A payout answers `pending`,
 *     not `succeeded`, because ACH takes days. The withdrawal sits in `approved` with the
 *     user's claim already debited, and only reaches `paid` when the rail confirms.
 */
export const DEV_FUNDING_PROVIDER_NAME = 'dev';

/** 2.9% + $0.30 on cards, a flat $0.80 on a bank debit: the shape of real US interchange. */
export const CARD_FEE_BPS = 290n;
export const CARD_FEE_FIXED_CENTS = 30n;
export const BANK_FEE_FIXED_CENTS = 80n;

/**
 * Amounts, in whole dollars, that always decline, and why. Chosen so a demo can show a
 * decline on purpose: $6.66 is refused by the issuer, $13.13 hits the velocity rule.
 */
export const SCRIPTED_DECLINES: Readonly<Record<string, string>> = {
  '666': 'card_declined',
  '1313': 'velocity_exceeded',
  '999999': 'amount_too_large',
};

export const DEV_FUNDING_CAPABILITIES: FundingCapabilities = {
  brands: ['visa', 'amex', 'discover', 'bank_account', 'apple_pay'],
  minimumDepositUsdCents: 500n,
  maximumDepositUsdCents: 250_000n,
  minimumWithdrawalUsdCents: 1_000n,
  withdrawalSettlementHours: 48,
};

export function devFundingProvider(): FundingProvider {
  return {
    name: DEV_FUNDING_PROVIDER_NAME,
    capabilities: DEV_FUNDING_CAPABILITIES,
    charge(request: ChargeRequest): Promise<FundingResult> {
      return Promise.resolve(chargeDev(request));
    },
    payout(request: PayoutRequest): Promise<FundingResult> {
      return Promise.resolve(payoutDev(request));
    },
  };
}

/** What the rail costs the platform to pull `amountUsdCents` over this instrument. */
export function railFee(brand: string, amountUsdCents: bigint): bigint {
  if (brand === 'bank_account') return BANK_FEE_FIXED_CENTS;
  return (amountUsdCents * CARD_FEE_BPS) / 10_000n + CARD_FEE_FIXED_CENTS;
}

export function chargeDev(request: ChargeRequest): FundingResult {
  const scripted = SCRIPTED_DECLINES[request.amountUsdCents.toString()];
  if (scripted !== undefined) {
    return {
      outcome: 'declined',
      providerRef: reference('ch', request.idempotencyKey),
      feeUsdCents: 0n,
      declineCode: scripted,
      note: `The rail declined this charge: ${scripted.replace(/_/g, ' ')}.`,
    };
  }
  if (request.amountUsdCents > DEV_FUNDING_CAPABILITIES.maximumDepositUsdCents) {
    return {
      outcome: 'declined',
      providerRef: reference('ch', request.idempotencyKey),
      feeUsdCents: 0n,
      declineCode: 'amount_too_large',
      note: 'Above the per-deposit ceiling this merchant is approved for.',
    };
  }
  return {
    outcome: 'succeeded',
    providerRef: reference('ch', request.idempotencyKey),
    feeUsdCents: railFee(request.instrument.brand, request.amountUsdCents),
    note: `Captured on ${request.instrument.brand} ending ${request.instrument.last4}.`,
  };
}

/**
 * A payout is accepted, not completed: `pending` is the honest answer for a rail that
 * takes days. `confirmPayoutDev` is what a provider webhook would later call.
 */
export function payoutDev(request: PayoutRequest): FundingResult {
  if (request.amountUsdCents < DEV_FUNDING_CAPABILITIES.minimumWithdrawalUsdCents) {
    return {
      outcome: 'declined',
      providerRef: reference('po', request.idempotencyKey),
      feeUsdCents: 0n,
      declineCode: 'below_minimum',
      note: 'Below the minimum the rail will move.',
    };
  }
  return {
    outcome: 'pending',
    providerRef: reference('po', request.idempotencyKey),
    feeUsdCents: 0n,
    note: `Submitted to ${request.instrument.brand} ending ${request.instrument.last4}; ACH settles in about ${DEV_FUNDING_CAPABILITIES.withdrawalSettlementHours} hours.`,
  };
}

/**
 * A provider-shaped reference: stable for an idempotency key, opaque, and carrying nothing
 * about the user. The same digest-of-the-key discipline the identity seam uses.
 */
function reference(prefix: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`funding:${prefix}:${idempotencyKey}`).digest('hex');
  return `${prefix}_${digest.slice(0, 24)}`;
}
