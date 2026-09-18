import type {
  ContestResource,
  EmbedTokenResource,
  ParticipantResource,
  PayoutResource,
  PreviewResource,
  PrizeStructure,
  ResultResource,
  ScoreResource,
  SettlementResource,
  UserResource,
  VerificationResource,
  WebhookDeliveryResource,
  WebhookEndpointResource,
} from '@purse/types';
import type { Id } from '@repo/ids';

import type { SettlementOutcome, SettlementPreview } from '../../contests';
import { activeParticipants, getContest } from '../../contests/load';
import { escrowBalance } from '../../contests/settlement';
import type { IssuedEmbedToken } from '../../auth/embed-tokens';
import type { DbOrTx } from '../../db/client';
import type { Contest, ContestParticipant, ContestResult, ContestScore, UserVerification, WebhookEndpoint } from '../../db/schema';
import type { Payout } from '../../settlement';
import { placedByUser, type UserProfile } from '../../users';
import type { DeliveryWithAttempts } from '../../webhooks';

/**
 * Rows to wire resources (`@purse/types`). Money becomes a decimal string, instants become
 * ISO 8601, and nothing internal (a hash, a connection, an actor ref, an operator's reason
 * for a restriction) is ever included.
 */
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function verificationResource(row: UserVerification): VerificationResource {
  return { state: row.state, provider: row.provider, verifiedAt: iso(row.verifiedAt), reverifyAfter: iso(row.reverifyAfter) };
}

export function userResource(profile: UserProfile): UserResource {
  const { user, verification, restrictions, location } = profile;
  return {
    id: user.id,
    externalId: user.externalId,
    displayName: user.displayName,
    phoneE164: user.phoneE164,
    dateOfBirth: user.dateOfBirth,
    verification: verificationResource(verification),
    restrictions: restrictions.map((restriction) => ({
      id: restriction.id,
      kind: restriction.kind,
      ...(placedByUser(restriction) ? { reason: restriction.reason } : {}),
      startsAt: restriction.startsAt.toISOString(),
      endsAt: iso(restriction.endsAt),
    })),
    location:
      location === undefined
        ? null
        : { regionCode: location.regionCode, source: location.source, resolvedAt: location.resolvedAt.toISOString(), confidence: location.confidence },
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function embedTokenResource(issued: IssuedEmbedToken): EmbedTokenResource {
  return { token: issued.token, replayed: false, flow: issued.row.flow, userId: issued.row.userId, expiresAt: issued.row.expiresAt.toISOString() };
}

/** The same resource as a replay returns it: the plaintext is handed out once and never stored. */
export function replayedEmbedToken(resource: EmbedTokenResource): EmbedTokenResource {
  return { ...resource, token: null, replayed: true };
}

export function contestResource(contest: Contest, escrow: bigint, participantCount: number): ContestResource {
  return {
    id: contest.id,
    externalId: contest.externalId,
    kind: contest.kind,
    title: contest.title,
    asset: contest.asset,
    entryAmount: contest.entryAmount.toString(),
    maxParticipants: contest.maxParticipants,
    prizeStructure: contest.prizeStructure as PrizeStructure,
    tieBreak: contest.tieBreak,
    settlementPolicy: contest.settlementPolicy,
    eligibilityRulesetVersion: contest.eligibilityRulesetVersion,
    state: contest.state,
    opensAt: iso(contest.opensAt),
    locksAt: iso(contest.locksAt),
    escrowAccountId: contest.escrowAccountId,
    escrowBalance: escrow.toString(),
    participantCount,
    settledAt: iso(contest.settledAt),
    createdAt: contest.createdAt.toISOString(),
    updatedAt: contest.updatedAt.toISOString(),
  };
}

/** A contest with the two derived figures the resource carries, read fresh. */
export async function loadContestResource(db: DbOrTx, tenantId: Id<'tnt'>, contestId: string): Promise<ContestResource> {
  const contest = await getContest(db, tenantId, contestId);
  return describeContest(db, contest);
}

export async function describeContest(db: DbOrTx, contest: Contest): Promise<ContestResource> {
  const [escrow, participants] = await Promise.all([escrowBalance(db, contest), activeParticipants(db, contest.id)]);
  return contestResource(contest, escrow, participants.length);
}

export function participantResource(row: ContestParticipant): ParticipantResource {
  return {
    id: row.id,
    contestId: row.contestId,
    userId: row.userId,
    teamRef: row.teamRef,
    seed: row.seed,
    state: row.state,
    joinedAt: row.joinedAt.toISOString(),
    entryJournalEntryId: row.entryJournalEntryId,
  };
}

export function scoreResource(row: ContestScore): ScoreResource {
  return {
    id: row.id,
    contestId: row.contestId,
    userId: row.userId,
    score: row.score,
    attemptFinished: row.attemptFinished,
    submittedAt: row.submittedAt.toISOString(),
    sourceRef: row.sourceRef,
  };
}

export function resultResource(row: ContestResult): ResultResource {
  return {
    id: row.id,
    contestId: row.contestId,
    userId: row.userId,
    placement: row.placement,
    score: row.score,
    payoutAmount: row.payoutAmount.toString(),
    payoutJournalEntryId: row.payoutJournalEntryId,
    computedAt: row.computedAt.toISOString(),
  };
}

export function payoutResource(payout: Payout): PayoutResource {
  return { userId: payout.userId, placement: payout.placement, payout: payout.payout.toString() };
}

export function previewResource(preview: SettlementPreview): PreviewResource {
  return {
    contestId: preview.contest.id,
    state: preview.contest.state,
    escrowTotal: preview.escrowTotal.toString(),
    entries: preview.entries.map((entry) => ({
      userId: entry.userId,
      participantId: entry.participantId,
      participantState: entry.participantState,
      score: entry.score,
      seed: entry.seed ?? null,
      attemptFinished: entry.attemptFinished,
    })),
    payouts: preview.payouts.map(payoutResource),
    payoutHash: preview.payoutHash,
  };
}

export async function settlementResource(db: DbOrTx, outcome: SettlementOutcome): Promise<SettlementResource> {
  return {
    contest: await describeContest(db, outcome.contest),
    results: outcome.results.map(resultResource),
    payoutHash: outcome.payoutHash,
    journalEntryId: outcome.entry?.entry.id ?? null,
  };
}

/** An endpoint on the wire. `secret` is the plaintext handed out once (creation, rotation) and `null` everywhere else; the envelope never leaves the database. */
export function endpointResource(endpoint: WebhookEndpoint, secret: string | null): WebhookEndpointResource {
  return {
    id: endpoint.id,
    url: endpoint.url,
    subscribedEvents: endpoint.subscribedEvents,
    status: endpoint.status,
    description: endpoint.description,
    secret,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}

export function deliveryResource({ delivery, attempts }: DeliveryWithAttempts): WebhookDeliveryResource {
  return {
    id: delivery.id,
    endpointId: delivery.endpointId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    status: delivery.status,
    attempt: delivery.attempt,
    maxAttempts: delivery.maxAttempts,
    responseStatus: delivery.responseStatus,
    nextAttemptAt: delivery.status === 'pending' || delivery.status === 'failed' ? delivery.nextAttemptAt.toISOString() : null,
    deliveredAt: iso(delivery.deliveredAt),
    replayOf: delivery.replayOf,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attempt: attempt.attempt,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt.toISOString(),
      responseStatus: attempt.responseStatus,
      error: attempt.error,
      durationMs: attempt.durationMs,
    })),
  };
}
