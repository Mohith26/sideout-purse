/**
 * The contest engine (spec 4.1, 4.3, 4.7): lifecycle, entries with escrow, append-only
 * scores, and settlement behind the preview hash. Every function here is a service with
 * typed input; the public v1 routes (`src/routes/v1`) mount on these same functions.
 * `transition` is the only writer of `contests.state`; the settlement engine it calls
 * lives in `../settlement` and is pure, and the eligibility engine an entry consults lives
 * in `../eligibility`.
 */
export { ContestError, CONTEST_ERROR_CODES, isContestError, type ContestErrorCode } from './errors';
export {
  TRANSITIONS,
  TRANSITION_ACTIONS,
  CONTEST_STATES,
  TERMINAL_STATES,
  ENTRY_HOLDING_STATES,
  canTransition,
  assertTransition,
} from './states';
export { transition, type TransitionInput, type Transitioned } from './transition';
export { transitionContest, PLAIN_TRANSITION_TARGETS, type TransitionContestInput, type TransitionedContest } from './lifecycle';
export { idempotent, ledgerKey, validateRequestKey, REQUEST_KEY_MAX, type IdempotencyScope, type Replayable, type IdempotentResult } from './idempotency';
export {
  getContest,
  lockContest,
  listParticipants,
  activeParticipants,
  findParticipant,
  getParticipant,
  currentScores,
  scoreHistory,
  scoresById,
  listResults,
} from './load';
export {
  createContest,
  updateContest,
  createContestSchema,
  updateContestSchema,
  type CreateContestInput,
  type CreateContestFields,
  type CreatedContest,
  type UpdateContestInput,
  type UpdateContestFields,
  type UpdatedContest,
} from './create';
export { evaluateEntryEligibility, notEligible, type EntryEligibilityInput } from './eligibility';
export { enterContest, withdrawEntry, loadEntry, type EnterContestInput, type EnteredContest, type WithdrawEntryInput, type WithdrawnEntry } from './entries';
export { submitScores, allExpectedResultsPresent, ACCEPTING_SCORES, type ScoreSubmission, type SubmitScoresInput, type SubmittedScores } from './scores';
export {
  previewSettlement,
  computeSettlement,
  executeSettlement,
  loadSettlement,
  closeContest,
  voidContest,
  escrowBalance,
  type PreviewEntry,
  type SettlementPreview,
  type SettlementOutcome,
  type ExecuteSettlementInput,
  type CloseContestInput,
  type ClosedContest,
  type VoidContestInput,
  type VoidedContest,
} from './settlement';
