/**
 * The treasury (spec section 13): the fiat rail Purse runs as merchant of record, and the
 * platform's rake.
 *
 * This is the only part of Purse that names real currency, and it names it *outside* the
 * journal on purpose. Decision D3 stands: there is no account of asset `USD`, the asset
 * enum cannot express one, and `test/ledger/usd.test.ts` still proves it. Dollars sit in
 * custody at a payment provider; the ledger records each user's claim on them in `CREDIT`,
 * one unit to one cent; invariant I8 holds those two descriptions of the same money equal,
 * and I9 does the same for the rake.
 */
export { TreasuryError, TREASURY_ERROR_CODES, isTreasuryError, type TreasuryErrorCode } from './errors';
export { PAYMENT_TRANSITIONS, INITIAL_STATE, canTransition, assertTransition } from './states';
export { CENTS_PER_CREDIT, applyBps, centsToCredit, creditToCents, formatUsd } from './money';
export {
  addPaymentMethod,
  confirmPayment,
  deposit,
  getPayment,
  listPaymentMethods,
  listPayments,
  paymentTrail,
  requestWithdrawal,
  returnPayment,
  treasuryPosition,
  type AddPaymentMethodInput,
  type DepositInput,
  type PaymentOutcome,
  type TreasuryContext,
  type TreasuryPosition,
  type WithdrawalInput,
} from './payments';
