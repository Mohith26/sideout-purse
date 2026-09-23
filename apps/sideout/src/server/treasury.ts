import { randomUUID } from 'node:crypto';

import type { AppContext } from './context';
import type { ParsedFundingCapabilities, ParsedPayment, ParsedTreasuryPosition } from '../purse';

/**
 * The treasury, read from Purse (spec section 13).
 *
 * Sideout does not move money on the fiat rail and structurally cannot: it holds no stored
 * instrument, has no column that could contain a US cent, and the schema test
 * (`test/schema-isolation.test.ts`) keeps it that way. Everything on the money screens is
 * Purse's answer, fetched over HTTPS with the secret key, exactly like every other Purse
 * read. That is the point of the screens: they are evidence of the boundary, not a
 * workaround for it.
 */

export type TreasurySnapshot = {
  position: ParsedTreasuryPosition;
  capabilities: ParsedFundingCapabilities;
  payments: ParsedPayment[];
  /** Set when Purse could not be reached, so the page degrades rather than failing. */
  unavailable: string | null;
};

export const EMPTY_SNAPSHOT: TreasurySnapshot = {
  position: {
    depositedUsdCents: '0',
    withdrawnUsdCents: '0',
    netCustodyUsdCents: '0',
    ledgerCustodyCredit: '0',
    railFeesUsdCents: '0',
    platformFeeCredit: '0',
    reconciled: true,
  },
  capabilities: {
    provider: 'none',
    brands: [],
    minimumDepositUsdCents: '0',
    maximumDepositUsdCents: '0',
    minimumWithdrawalUsdCents: '0',
    withdrawalSettlementHours: 0,
    unsupported: [],
  },
  payments: [],
  unavailable: 'Purse is not configured for this deployment, so there is no rail to read.',
};

export async function readTreasury(app: AppContext): Promise<TreasurySnapshot> {
  if (app.purse === null) return EMPTY_SNAPSHOT;
  const requestId = randomUUID();
  try {
    const [position, capabilities, payments] = await Promise.all([
      app.purse.getTreasuryPosition({ requestId }),
      app.purse.getFundingCapabilities({ requestId }),
      app.purse.listPayments({}, { requestId }),
    ]);
    return { position: position.data, capabilities: capabilities.data, payments: payments.data, unavailable: null };
  } catch (error) {
    return { ...EMPTY_SNAPSHOT, unavailable: error instanceof Error ? error.message : 'Purse could not be reached.' };
  }
}

/** One payment with every step it took, for the walkthrough. */
export async function readPayment(app: AppContext, paymentId: string): Promise<ParsedPayment | null> {
  if (app.purse === null) return null;
  try {
    const payment = await app.purse.getPayment(paymentId, { requestId: randomUUID() });
    return payment.data;
  } catch {
    return null;
  }
}

/**
 * The deposit the "follow a dollar" walkthrough narrates: the largest one that actually
 * funded. Picked from live rows rather than hardcoded, so the page keeps working after the
 * nightly reset mints new ids.
 */
export function walkthroughPayment(payments: readonly ParsedPayment[]): ParsedPayment | null {
  const funded = payments.filter((payment) => payment.direction === 'deposit' && payment.journalEntryId !== null);
  if (funded.length === 0) return null;
  return funded.reduce((best, payment) => (BigInt(payment.amountUsdCents) > BigInt(best.amountUsdCents) ? payment : best));
}

/** The one payment the rail refused, if there is one; the failure path deserves a screen too. */
export function declinedPayment(payments: readonly ParsedPayment[]): ParsedPayment | null {
  return payments.find((payment) => payment.state === 'failed') ?? null;
}

/** A withdrawal whose cash has not landed yet: approved, not paid. */
export function inFlightWithdrawal(payments: readonly ParsedPayment[]): ParsedPayment | null {
  return payments.find((payment) => payment.direction === 'withdrawal' && payment.state === 'approved') ?? null;
}

/** `$1,234.56` from US cents, given as a decimal string. The only place Sideout renders real currency. */
export function usd(value: bigint | string): string {
  const cents = typeof value === 'string' ? BigInt(value) : value;
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const dollars = absolute / 100n;
  const remainder = absolute % 100n;
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${remainder.toString().padStart(2, '0')}`;
}

/** How a payment state reads to a person, and what colour it deserves. */
export const PAYMENT_STATE_COPY: Readonly<Record<string, { label: string; tone: 'positive' | 'pending' | 'negative' | 'neutral'; meaning: string }>> = {
  requires_action: { label: 'Requires action', tone: 'pending', meaning: 'The payment exists; the rail has not been asked yet.' },
  authorized: { label: 'Authorized', tone: 'pending', meaning: 'The issuer is holding the funds. Nothing has been taken.' },
  captured: { label: 'Captured', tone: 'positive', meaning: 'The money is taken and the wallet is credited.' },
  settled: { label: 'Settled', tone: 'positive', meaning: 'The funds reached the merchant account.' },
  requested: { label: 'Requested', tone: 'pending', meaning: 'A withdrawal has been asked for and not yet judged.' },
  in_review: { label: 'In review', tone: 'pending', meaning: 'Held for a human to look at before money leaves.' },
  approved: { label: 'Approved', tone: 'pending', meaning: 'The claim is debited; the cash is still moving.' },
  paid: { label: 'Paid', tone: 'positive', meaning: 'The money reached the destination account.' },
  failed: { label: 'Failed', tone: 'negative', meaning: 'The rail refused it. Nothing was credited or debited.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', meaning: 'Abandoned before any money moved.' },
  refunded: { label: 'Refunded', tone: 'neutral', meaning: 'A captured deposit was sent back.' },
  returned: { label: 'Returned', tone: 'negative', meaning: 'The bank sent the payout back; the claim is restored.' },
};
