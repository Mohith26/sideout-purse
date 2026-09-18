import { and, eq, or, sql } from 'drizzle-orm';
import type { EligibilityDecision } from '@purse/types';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { eligibilityDecisions, operatorFlags, type Contest, type EligibilityDecisionRow, type OperatorFlag } from '../db/schema';
import type { RiskAssessment, RiskProvider } from '../providers/types';
import type { UserProfile } from '../users/profile';
import { ageOn, evaluate, type EvaluateInput } from './evaluate';
import type { Ruleset } from './ruleset';
import { entryVelocity, type Velocity } from './velocity';

/**
 * The impure half of the engine: gather the evaluator's input from the database (the
 * profile, the wallet, the journal's velocity), run the pure `evaluate`, consult the
 * `RiskProvider` seam for signals, and persist the decision with its context. `enterContest`
 * calls `decideEntry` under the contest row lock and `recordDecision` whether or not the
 * entry goes through.
 */
export type DecideEntryInput = {
  tenantId: Id<'tnt'>;
  profile: UserProfile;
  contest: Contest;
  walletBalance: bigint;
  ruleset: Ruleset;
  now: Date;
  risk?: RiskProvider;
};

export type EntryDecision = {
  decision: EligibilityDecision;
  input: EvaluateInput;
  velocity: Velocity;
  risk: RiskAssessment | null;
  /** What is persisted alongside the decision: the input as it stood, compactly. */
  context: Record<string, unknown>;
};

export async function decideEntry(db: DbOrTx, input: DecideEntryInput): Promise<EntryDecision> {
  const { profile, contest, ruleset, now } = input;
  const velocity = await entryVelocity(db, { tenantId: input.tenantId, userId: profile.user.id, asset: contest.asset, now });

  const evaluateInput: EvaluateInput = {
    user: {
      dateOfBirth: profile.user.dateOfBirth,
      verificationState: profile.verification.state,
      reverifyAfter: profile.verification.reverifyAfter?.toISOString() ?? null,
      restrictions: profile.restrictions.map((restriction) => ({
        kind: restriction.kind,
        startsAt: restriction.startsAt.toISOString(),
        endsAt: restriction.endsAt?.toISOString() ?? null,
        liftedAt: restriction.liftedAt?.toISOString() ?? null,
      })),
      region: profile.location?.regionCode ?? null,
    },
    contest: { asset: contest.asset, entryAmount: contest.entryAmount, kind: contest.kind },
    wallet: { balance: input.walletBalance },
    velocity,
    ruleset,
    asOf: now.toISOString(),
  };
  const decision = evaluate(evaluateInput);

  let risk: RiskAssessment | null = null;
  if (input.risk !== undefined) {
    const open = await openFlagsOf(db, input.tenantId, profile.user.id);
    risk = await input.risk.assess({
      tenantId: input.tenantId,
      userId: profile.user.id,
      contestId: contest.id,
      asset: contest.asset,
      amount: contest.entryAmount,
      velocity,
      openFlags: [...new Set(open.map((flag) => flag.kind))],
      accountAgeMs: Math.max(0, now.getTime() - profile.user.createdAt.getTime()),
      ruleset,
    });
  }

  const context: Record<string, unknown> = {
    asOf: evaluateInput.asOf,
    region: evaluateInput.user.region,
    locationSource: profile.location?.source ?? null,
    verificationState: profile.verification.state,
    reverifyAfter: evaluateInput.user.reverifyAfter,
    age: profile.user.dateOfBirth === null ? null : ageOn(profile.user.dateOfBirth, now),
    restrictions: profile.restrictions.map((restriction) => ({ id: restriction.id, kind: restriction.kind, endsAt: restriction.endsAt?.toISOString() ?? null })),
    asset: contest.asset,
    entryAmount: contest.entryAmount.toString(),
    balance: input.walletBalance.toString(),
    velocity: { enteredLast24h: velocity.enteredLast24h.toString(), enteredLast7d: velocity.enteredLast7d.toString() },
    ...(risk === null ? {} : { risk: { provider: input.risk?.name ?? null, decision: risk.decision, signals: risk.signals } }),
  };
  return { decision, input: evaluateInput, velocity, risk, context };
}

/** Open operator flags naming this user, as subject or as one of a flagged pair. */
export async function openFlagsOf(db: DbOrTx, tenantId: Id<'tnt'>, userId: string): Promise<OperatorFlag[]> {
  return db
    .select()
    .from(operatorFlags)
    .where(and(eq(operatorFlags.tenantId, tenantId), eq(operatorFlags.status, 'open'), or(eq(operatorFlags.subject, userId), sql`${operatorFlags.detail}->'users' ? ${userId}`)));
}

export type RecordDecisionInput = {
  tenantId: Id<'tnt'>;
  userId: string;
  contestId: string;
  decision: EligibilityDecision;
  context: Record<string, unknown>;
  requestId?: string;
};

/** Persist one decision row (spec 4.5: the ruleset version on every persisted decision). */
export async function recordDecision(db: DbOrTx, input: RecordDecisionInput): Promise<EligibilityDecisionRow> {
  const [row] = await db
    .insert(eligibilityDecisions)
    .values({
      id: newId('eld'),
      tenantId: input.tenantId,
      userId: input.userId,
      contestId: input.contestId,
      rulesetVersion: input.decision.rulesetVersion,
      allowed: input.decision.allowed,
      reasons: input.decision.allowed ? [] : input.decision.reasons,
      requiredAction: input.decision.allowed ? null : (input.decision.requiredAction ?? null),
      context: input.context,
      requestId: input.requestId ?? null,
    })
    .returning();
  if (row === undefined) throw new Error('eligibility_decisions insert returned no row');
  return row;
}

/**
 * A `review` from the risk seam becomes an operator flag (spec 4.6: surfaced, not acted
 * on), one per user and contest; an `allow` leaves nothing behind.
 */
export async function flagRiskReview(db: DbOrTx, input: { tenantId: Id<'tnt'>; userId: string; contestId: string; risk: RiskAssessment; provider: string }): Promise<OperatorFlag | undefined> {
  if (input.risk.decision === 'allow') return undefined;
  const [flag] = await db
    .insert(operatorFlags)
    .values({
      id: newId('flg'),
      tenantId: input.tenantId,
      kind: 'risk_review',
      subject: input.userId,
      dedupeKey: `user:${input.userId}:contest:${input.contestId}`,
      detail: { userId: input.userId, contestId: input.contestId, provider: input.provider, decision: input.risk.decision, signals: input.risk.signals },
    })
    .onConflictDoNothing({ target: [operatorFlags.tenantId, operatorFlags.kind, operatorFlags.dedupeKey] })
    .returning();
  return flag;
}
