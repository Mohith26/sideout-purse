import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../db/client';
import {
  matchConsensus,
  matches,
  pools,
  scoreSubmissions,
  sets,
  teamMembers,
  teams,
  tournaments,
  users,
  type BestOf,
  type ConsensusState,
  type Match,
  type MatchConsensus,
  type MatchStatus,
  type ScoreSubmission,
  type Team,
  type User,
} from '../db/schema';
import { advanceWinner } from '../domain/bracket';
import {
  agreedOutcome,
  assertLegalScoreline,
  canonicalizeSubmission,
  CONSENSUS_AUDIT,
  ConsensusError,
  consensusEvent,
  diffScorelines,
  idempotencyKeyFor,
  judgeSubmission,
  toMatchOrientation,
  toPerspective,
  validateConsensusTransition,
  type AgreedOutcome,
  type SetDifference,
  type SubmittedScoreline,
} from '../domain/consensus';
import type { SetScore, Side } from '../domain/scoreline';
import { validateMatchTransition } from '../domain/state';
import { actorFor, SYSTEM_ACTOR, type Actor } from './actor';
import { writeAudit } from './audit';
import type { DbOrTx, Tx } from './db';
import { failure } from './http/errors';

/**
 * The consensus service: the trust boundary between a phone on the sand and anything that
 * moves value (spec 5.2). Two entry points write, each in one transaction with its audit
 * rows, taking the tournament lock first and the match lock second, the order every
 * other match writer takes:
 *
 * - `submitScoreline`: a player records their team's result. The team is resolved from
 *   `team_members` in the query, never trusted from the client (rule 2); legality is judged
 *   before anything is stored (rule 3); the scoreline is canonicalized to the match
 *   orientation and hashed (rule 1). The first legal submission is what takes a match off
 *   the schedule: `scheduled → in_progress → awaiting_scores`, as the player.
 * - `resolveDispute`: an organizer settles a dispute with an authoritative scoreline,
 *   attributed to them in `resolved_by_user_id` and in the audit row.
 *
 * Both reach `agreed` through `enterAgreed`: the agreed `sets` rows are written, the
 * consensus records the hash and mints its idempotency key (only if it has none, rule 4),
 * the match becomes `final` as the system, and the winner advances through
 * `domain/bracket.ts`. Nothing here talks to Purse: the push is `server/purse/scores.ts`,
 * which the routes call after these transactions commit.
 */

export type ConsensusOutcome = Extract<ConsensusState, 'awaiting_second' | 'agreed' | 'disputed'>;

export type SubmitResult = {
  outcome: ConsensusOutcome;
  /** Whether this submission replaced an earlier one from the same team. */
  replaced: boolean;
  submissionId: string;
  /** The submitter's side in the match. */
  perspective: Side;
  consensus: MatchConsensus;
  match: Match;
};

export type ResolveResult = { consensus: MatchConsensus; match: Match; submissionId: string };

type LoadedMatch = { match: Match; tournamentStatus: string; consensus: MatchConsensus | null };

async function loadMatchForUpdate(tx: Tx, matchId: string): Promise<LoadedMatch> {
  const [located] = await tx.select({ tournamentId: matches.tournamentId }).from(matches).where(eq(matches.id, matchId));
  if (located === undefined) throw failure.notFound('match_not_found', 'No such match.');
  const [tournament] = await tx.select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, located.tournamentId)).for('update');
  const [match] = await tx.select().from(matches).where(eq(matches.id, matchId)).for('update');
  if (match === undefined || tournament === undefined) throw failure.notFound('match_not_found', 'No such match.');
  const [consensus] = await tx.select().from(matchConsensus).where(eq(matchConsensus.matchId, matchId)).for('update');
  return { match, tournamentStatus: tournament.status, consensus: consensus ?? null };
}

/** The team a user plays for in a match, resolved from `team_members`, never from the client (rule 2). */
export async function findSubmitterTeam(db: DbOrTx, match: Pick<Match, 'teamAId' | 'teamBId'>, userId: string): Promise<{ team: Team; side: Side } | null> {
  const ids = [match.teamAId, match.teamBId].filter((id): id is string => id !== null);
  if (ids.length === 0) return null;
  const [row] = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, ids)))
    .limit(1);
  if (row === undefined) return null;
  return { team: row.team, side: row.team.id === match.teamAId ? 'a' : 'b' };
}

/** Non-superseded submissions for a match, oldest first: at most one per team, plus any organizer resolution. */
export async function listLiveSubmissions(db: DbOrTx, matchId: string): Promise<ScoreSubmission[]> {
  return db
    .select()
    .from(scoreSubmissions)
    .where(and(eq(scoreSubmissions.matchId, matchId), isNull(scoreSubmissions.supersededById)))
    .orderBy(asc(scoreSubmissions.createdAt), asc(scoreSubmissions.id));
}

/** Match-oriented sets of a stored submission. */
export function submissionSets(submission: Pick<ScoreSubmission, 'sets' | 'perspective'>): SetScore[] {
  return toMatchOrientation(submission.sets, submission.perspective);
}

async function ensureConsensus(tx: Tx, matchId: string, existing: MatchConsensus | null, now: Date): Promise<MatchConsensus> {
  if (existing !== null) return existing;
  const [row] = await tx.insert(matchConsensus).values({ id: newId('mcs'), matchId, state: 'awaiting_first', createdAt: now, updatedAt: now }).returning();
  if (row === undefined) throw new Error('match_consensus insert returned no row');
  return row;
}

/** Move a consensus row along one edge of the table, auditing it. Shared with the Purse push (`server/purse/scores.ts`). */
export async function moveConsensus(
  tx: DbOrTx,
  consensus: MatchConsensus,
  to: ConsensusState,
  actor: Actor,
  now: Date,
  patch: Partial<typeof matchConsensus.$inferInsert>,
  detail: Record<string, unknown>,
): Promise<MatchConsensus> {
  const verdict = validateConsensusTransition(consensus.state, to, actor.kind);
  if (!verdict.ok) throw new ConsensusError('invalid_transition', verdict.message, { from: consensus.state, to });
  const [updated] = await tx
    .update(matchConsensus)
    .set({ ...patch, state: to, updatedAt: now })
    .where(eq(matchConsensus.id, consensus.id))
    .returning();
  if (updated === undefined) throw new Error('match_consensus update returned no row');
  await writeAudit(tx, {
    actor,
    action: CONSENSUS_AUDIT.stateChanged,
    subjectType: 'match',
    subjectId: consensus.matchId,
    detail: { consensusId: consensus.id, from: consensus.state, to, event: consensusEvent(consensus.state, to) ?? null, ...detail },
    at: now,
  });
  return updated;
}

async function moveMatch(tx: Tx, match: Match, to: MatchStatus, actor: Actor, now: Date, patch: Partial<typeof matches.$inferInsert>, detail: Record<string, unknown>): Promise<Match> {
  const verdict = validateMatchTransition(match.status, to, actor.kind);
  if (!verdict.ok) throw new ConsensusError('invalid_transition', verdict.message, { from: match.status, to });
  const [updated] = await tx
    .update(matches)
    .set({ ...patch, status: to, updatedAt: now })
    .where(eq(matches.id, match.id))
    .returning();
  if (updated === undefined) throw new Error('match update returned no row');
  await writeAudit(tx, { actor, action: 'match.status_changed', subjectType: 'match', subjectId: match.id, detail: { from: match.status, to, ...detail }, at: now });
  return updated;
}

/**
 * Everything that happens on entering `agreed`, from either path: the agreed `sets` rows
 * replace any provisional ones, the consensus records the hash and mints its key (only if
 * it has none), the match becomes `final` as the system with its winner, and the winner
 * moves into the next bracket slot.
 */
async function enterAgreed(
  tx: Tx,
  loaded: LoadedMatch,
  consensus: MatchConsensus,
  outcome: AgreedOutcome,
  actor: Actor,
  now: Date,
  extra: { resolvedByUserId: string | null; mintKey: () => string },
): Promise<{ consensus: MatchConsensus; match: Match }> {
  const idempotencyKey = idempotencyKeyFor(consensus.idempotencyKey, extra.mintKey);
  const moved = await moveConsensus(
    tx,
    consensus,
    'agreed',
    actor,
    now,
    { agreedHash: outcome.hash, idempotencyKey, resolvedByUserId: extra.resolvedByUserId, disputedReason: null, disputedSets: null },
    { hash: outcome.hash, idempotencyKey, mintedKey: consensus.idempotencyKey === null, winnerTeamId: outcome.winnerTeamId, resolvedByUserId: extra.resolvedByUserId },
  );

  await tx.delete(sets).where(eq(sets.matchId, loaded.match.id));
  await tx.insert(sets).values(
    outcome.sets.map((s) => ({ id: newId('set'), matchId: loaded.match.id, setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints, agreed: true, createdAt: now })),
  );

  const finalised = await moveMatch(tx, loaded.match, 'final', SYSTEM_ACTOR, now, { winnerTeamId: outcome.winnerTeamId, finalizedAt: now }, { consensusId: consensus.id, hash: outcome.hash, winnerTeamId: outcome.winnerTeamId });
  const advancement = advanceWinner(loaded.match, outcome.winnerTeamId);
  if (advancement !== null) {
    await tx
      .update(matches)
      .set(
        advancement.slot === 'a'
          ? { teamAId: outcome.winnerTeamId, teamASeed: advancement.seed, updatedAt: now }
          : { teamBId: outcome.winnerTeamId, teamBSeed: advancement.seed, updatedAt: now },
      )
      .where(eq(matches.id, advancement.nextMatchId));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'match.advanced',
      subjectType: 'match',
      subjectId: advancement.nextMatchId,
      detail: { fromMatchId: loaded.match.id, slot: advancement.slot, teamId: outcome.winnerTeamId, seed: advancement.seed },
      at: now,
    });
  }
  return { consensus: moved, match: finalised };
}

/** The column is a checked integer (1 or 3); the rules take the literal type. */
function asBestOf(value: number): BestOf {
  if (value !== 1 && value !== 3) throw new Error(`match best_of ${value} is not 1 or 3`);
  return value;
}

/** Match statuses a team may submit a scoreline for. */
const SUBMITTABLE: ReadonlySet<MatchStatus> = new Set<MatchStatus>(['scheduled', 'in_progress', 'awaiting_scores']);

/** Walk the match to `awaiting_scores` as the submitting player: a scheduled match goes on the sand first. */
async function openForScores(tx: Tx, loaded: LoadedMatch, actor: Actor, now: Date, detail: Record<string, unknown>): Promise<void> {
  if (loaded.match.status === 'scheduled') loaded.match = await moveMatch(tx, loaded.match, 'in_progress', actor, now, { startedAt: now }, detail);
  if (loaded.match.status === 'in_progress') loaded.match = await moveMatch(tx, loaded.match, 'awaiting_scores', actor, now, {}, detail);
}

function assertLive(loaded: LoadedMatch): void {
  if (loaded.tournamentStatus !== 'live') {
    throw new ConsensusError('match_not_open', `Scores are recorded while the tournament is live; it is ${loaded.tournamentStatus.replace('_', ' ')}.`, { tournamentStatus: loaded.tournamentStatus });
  }
}

/** A consensus rule broken, as the API envelope: the code is stable, the message specific. */
export function toFailure(error: unknown): unknown {
  if (!(error instanceof ConsensusError)) return error;
  switch (error.code) {
    case 'illegal_scoreline':
      return failure.invalidRequest('illegal_scoreline', error.message, error.detail);
    case 'not_on_team':
      return failure.permission('not_on_team', error.message, error.detail);
    case 'already_decided':
    case 'match_not_open':
    case 'invalid_transition':
      return failure.invalidState(error.code, error.message, error.detail);
  }
}

// ---- Player submission -----------------------------------------------------------------------

export type SubmitScorelineInput = {
  matchId: string;
  user: User;
  scoreline: SubmittedScoreline;
  now: Date;
  /** Mints the consensus idempotency key the first time the match is agreed; tests inject a counter. */
  mintKey?: () => string;
};

export async function submitScoreline(db: Db, input: SubmitScorelineInput): Promise<SubmitResult> {
  const { now } = input;
  const actor = actorFor(input.user);
  const mintKey = input.mintKey ?? randomUUID;
  try {
    return await db.transaction(async (tx) => {
      const loaded = await loadMatchForUpdate(tx, input.matchId);
      const { match } = loaded;

      const membership = await findSubmitterTeam(tx, match, input.user.id);
      if (membership === null) throw new ConsensusError('not_on_team', 'Only a member of one of the two teams can submit this match’s score.');
      assertLive(loaded);

      if (match.status === 'disputed' || match.status === 'final') {
        const message =
          match.status === 'disputed'
            ? 'Both teams have submitted and the scorelines differ; the organizer will settle it. Nothing more can be submitted.'
            : 'Both teams have already confirmed this result; it is final.';
        throw new ConsensusError('already_decided', message, { state: loaded.consensus?.state ?? null, status: match.status });
      }
      if (!SUBMITTABLE.has(match.status)) {
        throw new ConsensusError('match_not_open', `Scores are submitted for a match that is scheduled, in progress or awaiting scores; this one is ${match.status}.`, { status: match.status });
      }
      if (match.teamAId === null || match.teamBId === null) throw new ConsensusError('match_not_open', 'This match does not have both teams yet.', { status: match.status });

      // Rule 3: plausibility before anything is stored.
      const bestOf = asBestOf(match.bestOf);
      const canonical = canonicalizeSubmission(match.id, input.scoreline.sets, membership.side, bestOf);
      assertLegalScoreline(canonical, bestOf);

      const consensus = await ensureConsensus(tx, match.id, loaded.consensus, now);
      const live = await listLiveSubmissions(tx, match.id);
      const mine = live.find((s) => s.submittedForTeamId === membership.team.id) ?? null;
      const standing = live.find((s) => s.submittedForTeamId !== null && s.submittedForTeamId !== membership.team.id) ?? null;

      const submissionId = newId('ssb');
      await tx.insert(scoreSubmissions).values({
        id: submissionId,
        matchId: match.id,
        submittedByUserId: input.user.id,
        submittedForTeamId: membership.team.id,
        perspective: membership.side,
        sets: toPerspective(canonical.sets, membership.side),
        hash: canonical.hash,
        createdAt: now,
      });
      if (mine !== null) {
        // Never updated, only superseded: the earlier row stays as the record.
        await tx.update(scoreSubmissions).set({ supersededById: submissionId }).where(eq(scoreSubmissions.id, mine.id));
        await writeAudit(tx, {
          actor,
          action: CONSENSUS_AUDIT.scoreSuperseded,
          subjectType: 'match',
          subjectId: match.id,
          detail: { teamId: membership.team.id, supersededId: mine.id, bySubmissionId: submissionId },
          at: now,
        });
      }
      await writeAudit(tx, {
        actor,
        action: CONSENSUS_AUDIT.scoreSubmitted,
        subjectType: 'match',
        subjectId: match.id,
        detail: { submissionId, teamId: membership.team.id, side: membership.side, hash: canonical.hash, replaced: mine !== null },
        at: now,
      });

      const decision = judgeSubmission({
        state: consensus.state,
        submission: { teamId: membership.team.id, hash: canonical.hash, sets: canonical.sets },
        standing: standing?.submittedForTeamId === undefined || standing.submittedForTeamId === null ? null : { teamId: standing.submittedForTeamId, hash: standing.hash, sets: submissionSets(standing) },
        replaces: mine !== null,
        side: membership.side,
      });

      switch (decision.next) {
        case 'awaiting_second': {
          let current: MatchConsensus;
          if (consensus.state === 'awaiting_first') {
            current = await moveConsensus(tx, consensus, 'awaiting_second', actor, now, {}, { teamId: membership.team.id, submissionId });
          } else {
            const [touched] = await tx.update(matchConsensus).set({ updatedAt: now }).where(eq(matchConsensus.id, consensus.id)).returning();
            current = touched ?? consensus;
          }
          await openForScores(tx, loaded, actor, now, { submissionId });
          return { outcome: 'awaiting_second', replaced: decision.replaced, submissionId, perspective: membership.side, consensus: current, match: loaded.match };
        }
        case 'agreed': {
          await openForScores(tx, loaded, actor, now, { submissionId });
          const outcome = agreedOutcome({ ...match, bestOf }, canonical.sets);
          const entered = await enterAgreed(tx, loaded, consensus, outcome, actor, now, { resolvedByUserId: null, mintKey });
          return { outcome: 'agreed', replaced: mine !== null, submissionId, perspective: membership.side, consensus: entered.consensus, match: entered.match };
        }
        case 'disputed': {
          await openForScores(tx, loaded, actor, now, { submissionId });
          const disputed = await moveConsensus(
            tx,
            consensus,
            'disputed',
            actor,
            now,
            { disputedReason: decision.reason, disputedSets: decision.differences },
            { reason: decision.reason, differences: decision.differences, hashes: [standing?.hash ?? null, canonical.hash] },
          );
          const match2 = await moveMatch(tx, loaded.match, 'disputed', SYSTEM_ACTOR, now, {}, { consensusId: consensus.id, reason: decision.reason });
          return { outcome: 'disputed', replaced: false, submissionId, perspective: membership.side, consensus: disputed, match: match2 };
        }
      }
    });
  } catch (error) {
    throw toFailure(error);
  }
}

// ---- Organizer resolution --------------------------------------------------------------------

export type ResolveDisputeInput = {
  matchId: string;
  organizer: User;
  /** Match-oriented: team A's points first. */
  sets: readonly SetScore[];
  now: Date;
  mintKey?: () => string;
};

export async function resolveDispute(db: Db, input: ResolveDisputeInput): Promise<ResolveResult> {
  if (input.organizer.role !== 'organizer') throw failure.permission('organizer_required', 'Only an organizer can resolve a dispute.');
  const { now } = input;
  const actor = actorFor(input.organizer);
  const mintKey = input.mintKey ?? randomUUID;
  try {
    return await db.transaction(async (tx) => {
      const loaded = await loadMatchForUpdate(tx, input.matchId);
      const { match, consensus } = loaded;
      assertLive(loaded);
      if (consensus?.state !== 'disputed' || match.status !== 'disputed') {
        throw new ConsensusError('invalid_transition', `Only a disputed match can be resolved; this one is ${consensus?.state ?? 'not yet submitted'}.`, { state: consensus?.state ?? null, status: match.status });
      }
      if (match.teamAId === null || match.teamBId === null) throw new ConsensusError('invalid_transition', 'This match does not have both teams.');

      const bestOf = asBestOf(match.bestOf);
      const canonical = canonicalizeSubmission(
        match.id,
        input.sets.map((s) => ({ setNumber: s.setNumber, usPoints: s.teamAPoints, themPoints: s.teamBPoints })),
        'a',
        bestOf,
      );
      assertLegalScoreline(canonical, bestOf);

      const submissionId = newId('ssb');
      await tx.insert(scoreSubmissions).values({
        id: submissionId,
        matchId: match.id,
        submittedByUserId: input.organizer.id,
        submittedForTeamId: null,
        perspective: 'a',
        sets: toPerspective(canonical.sets, 'a'),
        hash: canonical.hash,
        createdAt: now,
      });
      await writeAudit(tx, {
        actor,
        action: CONSENSUS_AUDIT.scoreSubmitted,
        subjectType: 'match',
        subjectId: match.id,
        detail: { submissionId, teamId: null, side: 'organizer', hash: canonical.hash, resolution: true, resolvedByUserId: input.organizer.id },
        at: now,
      });

      const outcome = agreedOutcome({ ...match, bestOf }, canonical.sets);
      const entered = await enterAgreed(tx, loaded, consensus, outcome, actor, now, { resolvedByUserId: input.organizer.id, mintKey });
      return { consensus: entered.consensus, match: entered.match, submissionId };
    });
  } catch (error) {
    throw toFailure(error);
  }
}

// ---- Read models ------------------------------------------------------------------------------

export type SubmissionView = {
  id: string;
  /** Null for an organizer's resolution. */
  teamId: string | null;
  teamName: string | null;
  submittedBy: { userId: string; displayName: string; role: User['role'] };
  /** Match-oriented. */
  sets: SetScore[];
  hash: string;
  createdAt: string;
  supersededById: string | null;
};

export type ConsensusView = {
  matchId: string;
  state: ConsensusState;
  agreedHash: string | null;
  disputedReason: string | null;
  differences: SetDifference[];
  resolvedBy: { userId: string; displayName: string } | null;
  pushedAt: string | null;
  confirmedAt: string | null;
  lastPushError: MatchConsensus['lastPushError'];
  updatedAt: string;
  /** The standing submission per side, oldest first; superseded rows are left out. */
  live: SubmissionView[];
  /** Every row ever recorded for the match, newest first. */
  history: SubmissionView[];
};

async function submissionViews(db: DbOrTx, matchIds: readonly string[]): Promise<Map<string, SubmissionView[]>> {
  const out = new Map<string, SubmissionView[]>();
  if (matchIds.length === 0) return out;
  const rows = await db
    .select({ sub: scoreSubmissions, teamName: teams.name, userName: users.displayName, userRole: users.role })
    .from(scoreSubmissions)
    .leftJoin(teams, eq(teams.id, scoreSubmissions.submittedForTeamId))
    .innerJoin(users, eq(users.id, scoreSubmissions.submittedByUserId))
    .where(inArray(scoreSubmissions.matchId, [...matchIds]))
    .orderBy(desc(scoreSubmissions.createdAt), desc(scoreSubmissions.id));
  for (const { sub, teamName, userName, userRole } of rows) {
    const list = out.get(sub.matchId) ?? [];
    list.push({
      id: sub.id,
      teamId: sub.submittedForTeamId,
      teamName,
      submittedBy: { userId: sub.submittedByUserId, displayName: userName, role: userRole },
      sets: submissionSets(sub),
      hash: sub.hash,
      createdAt: sub.createdAt.toISOString(),
      supersededById: sub.supersededById,
    });
    out.set(sub.matchId, list);
  }
  return out;
}

export async function consensusViews(db: DbOrTx, matchIds: readonly string[]): Promise<Map<string, ConsensusView>> {
  const out = new Map<string, ConsensusView>();
  if (matchIds.length === 0) return out;
  const rows = await db
    .select({ consensus: matchConsensus, resolverName: users.displayName, teamAId: matches.teamAId, teamBId: matches.teamBId })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .leftJoin(users, eq(users.id, matchConsensus.resolvedByUserId))
    .where(inArray(matchConsensus.matchId, [...matchIds]));
  const submissions = await submissionViews(db, matchIds);
  for (const { consensus, resolverName, teamAId, teamBId } of rows) {
    const history = submissions.get(consensus.matchId) ?? [];
    const live = history.filter((s) => s.supersededById === null).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const sideA = teamAId === null ? undefined : live.find((s) => s.teamId === teamAId);
    const sideB = teamBId === null ? undefined : live.find((s) => s.teamId === teamBId);
    out.set(consensus.matchId, {
      matchId: consensus.matchId,
      state: consensus.state,
      agreedHash: consensus.agreedHash,
      disputedReason: consensus.disputedReason,
      differences: consensus.disputedSets ?? (sideA !== undefined && sideB !== undefined ? diffScorelines(sideA.sets, sideB.sets) : []),
      resolvedBy: consensus.resolvedByUserId === null ? null : { userId: consensus.resolvedByUserId, displayName: resolverName ?? '' },
      pushedAt: consensus.pushedAt?.toISOString() ?? null,
      confirmedAt: consensus.confirmedAt?.toISOString() ?? null,
      lastPushError: consensus.lastPushError,
      updatedAt: consensus.updatedAt.toISOString(),
      live,
      history,
    });
  }
  return out;
}

export async function consensusView(db: DbOrTx, matchId: string): Promise<ConsensusView | null> {
  return (await consensusViews(db, [matchId])).get(matchId) ?? null;
}

/** The viewer's side in a match, from `team_members`; null for a spectator. */
export async function viewerSide(db: DbOrTx, match: Pick<Match, 'teamAId' | 'teamBId'>, userId: string | null): Promise<Side | null> {
  if (userId === null) return null;
  return (await findSubmitterTeam(db, match, userId))?.side ?? null;
}

export type DisputeView = {
  match: Match;
  tournament: { id: string; slug: string; name: string };
  poolLabel: string | null;
  teamA: { id: string; name: string } | null;
  teamB: { id: string; name: string } | null;
  consensus: ConsensusView;
};

/**
 * Every match still standing as `disputed`, oldest dispute first; optionally one
 * tournament's. Both the consensus and the match must say so: an organizer's forfeit
 * settles a disputed match without touching the consensus row, and it then needs nobody's
 * attention.
 */
export async function listDisputes(db: DbOrTx, tournamentId?: string): Promise<DisputeView[]> {
  const open = and(eq(matchConsensus.state, 'disputed'), eq(matches.status, 'disputed'));
  const rows = await db
    .select({ match: matches, tournament: tournaments, poolLabel: pools.label })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .where(tournamentId === undefined ? open : and(open, eq(matches.tournamentId, tournamentId)))
    .orderBy(asc(matchConsensus.updatedAt), asc(matchConsensus.id));
  if (rows.length === 0) return [];
  const teamIds = [...new Set(rows.flatMap((r) => [r.match.teamAId, r.match.teamBId]).filter((id): id is string => id !== null))];
  const teamRows = teamIds.length === 0 ? [] : await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds));
  const teamsById = new Map(teamRows.map((t) => [t.id, t]));
  const views = await consensusViews(db, rows.map((r) => r.match.id));
  return rows.flatMap(({ match, tournament, poolLabel }) => {
    const consensus = views.get(match.id);
    if (consensus === undefined) return [];
    return [
      {
        match,
        tournament: { id: tournament.id, slug: tournament.slug, name: tournament.name },
        poolLabel,
        teamA: match.teamAId === null ? null : (teamsById.get(match.teamAId) ?? null),
        teamB: match.teamBId === null ? null : (teamsById.get(match.teamBId) ?? null),
        consensus,
      },
    ];
  });
}
