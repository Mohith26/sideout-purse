/**
 * The settlement engine (spec 4.4). Pure: nothing in this directory may import a database,
 * a clock or a source of randomness, and the property tests in
 * `test/settlement/` hold it to that. `previewSettlement` and `closeContest`
 * (`src/contests/settlement.ts`) both call `settle` and compare `payoutHash`; that they are
 * the same function is what makes the preview frozen.
 */
export { settle, rank, proportional, evenSplit } from './settle';
export { payoutHash, canonicalPayouts, PAYOUT_HASH_SHAPE, PAYOUT_HASH_VERSION } from './hash';
export { SettlementError, isSettlementError, SETTLEMENT_ERROR_CODES, type SettlementErrorCode } from './errors';
export {
  prizeStructureSchema,
  tieBreakRuleSchema,
  TIE_BREAK_RULES,
  PRIZE_STRUCTURE_TYPES,
  type PrizeStructure,
  type PrizeStructureType,
  type TieBreakRule,
  type SettleEntry,
  type SettleInput,
  type Payout,
} from './types';
