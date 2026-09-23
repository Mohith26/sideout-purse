/**
 * Sideout's side of the Purse boundary, server only. Everything Sideout says to Purse goes
 * through `PurseClient`; everything Purse says back is parsed by `schemas.ts`; every
 * exchange is recorded by `calls.ts`. Nothing here is imported by a client component, and
 * the secret key never leaves `PurseClient` (`test/purse/bundle.test.ts` and
 * `scripts/check-bundle.ts` hold the built client bundle to that).
 */
export { PurseClient, DEFAULT_PURSE_TIMEOUT_MS, type CallContext, type CallRecorder, type CallStart, type CallOutcome, type CallSubject, type PurseResponse, type CreateContestInput, type ScoreSubmissionInput, type ContestTransitionName } from './client';
export { PurseApiError, PurseUnreachableError, PurseResponseError, PurseNotConfiguredError, isPurseFailure, describeFailure, type PurseFailure } from './errors';
export { databaseCallRecorder, listPurseCalls, toPurseCallView, type PurseCallView, type PurseCallsPage } from './calls';
export { redact, redactString, REDACTED } from './redact';
export type { ParsedContest, ParsedEntry, ParsedPreview, ParsedScores, ParsedSettlement, ParsedUser, ParsedWallet, ParsedEmbedToken } from './schemas';
export type { ParsedPayment, ParsedPaymentEvent, ParsedTreasuryPosition, ParsedFundingCapabilities } from './schemas';
