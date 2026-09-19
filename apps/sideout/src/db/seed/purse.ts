import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from '@repo/logger';

import { matchConsensus, matches, teamMembers, teams, tournaments, users, type Tournament, type User } from '../schema';
import { PurseApiError, type PurseClient } from '../../purse';
import { SYSTEM_ACTOR } from '../../server/actor';
import { writeAudit } from '../../server/audit';
import { confirmedTeamsFilter } from '../../server/field';
import { closeKey } from '../../server/purse/close';
import { contestSubject, ensurePurseContest, mirrorContestState, readBackEntries } from '../../server/purse/contests';
import { idempotencyKey, type PurseDeps } from '../../server/purse/deps';
import { pushFinalStandings, pushMatchScores } from '../../server/purse/scores';
import { linkPurseUser } from '../../server/purse/users';
import { SEED_SLUGS } from './build';

/**
 * The seed's Purse walk: what a live run would have done to Purse for the seeded
 * tournaments, done through the same services, so the local Purse holds a settled
 * contest for the settled event, in-progress ones with their pushed matches for the live
 * events, open ones with entries for the events taking or done taking registrations, and
 * a voided one (every stake refunded) for the cancelled event, and `purse_calls` shows
 * every request. Every step is idempotent under the same keys the app uses, so a reseed
 * replays rather than repeats. Runs only when `SIDEOUT_PURSE_SECRET_KEY` is set and the
 * API answers `/health`; otherwise `scripts/seed.ts` says so and the contest columns stay
 * null.
 */
export type SeedPurseSummary = {
  linked: number;
  tournaments: Array<{ slug: string; contestId: string; contestState: string; entered: number; pushed: number; settled: boolean }>;
};

export async function purseReachable(apiUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function linkPlayers(deps: PurseDeps, players: User[], now: Date): Promise<number> {
  let linked = 0;
  for (const player of players) {
    const [fresh] = await deps.db.select().from(users).where(eq(users.id, player.id));
    if (fresh === undefined) continue;
    await linkPurseUser(deps, { user: fresh, requestId: `seed-link-${player.id}`, now });
    linked += 1;
  }
  return linked;
}

async function enterPlayers(deps: PurseDeps, purse: PurseClient, tournament: Tournament, contestId: string): Promise<number> {
  const roster = await deps.db
    .select({ user: users, teamId: teams.id })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(confirmedTeamsFilter(tournament.id))
    .orderBy(asc(teams.createdAt), asc(teamMembers.createdAt));
  let entered = 0;
  for (const { user, teamId } of roster) {
    if (user.purseUserId === null) continue;
    try {
      await purse.enterContest(contestId, { userId: user.purseUserId, teamRef: teamId }, { requestId: `seed-entry-${user.id}`, idempotencyKey: idempotencyKey(tournament.purseExternalId, 'entry', user.id), subject: contestSubject(tournament) });
      entered += 1;
    } catch (error) {
      // An entry Purse refuses (already entered under another key, not eligible) is recorded in purse_calls; the seed goes on.
      if (!(error instanceof PurseApiError)) throw error;
      deps.log.warn('seed: Purse refused an entry', { userId: user.id, code: error.code, message: error.message });
    }
  }
  return entered;
}

/** Push every `agreed` (or half-pushed) match of the tournament, oldest first. */
async function pushAgreedMatches(deps: PurseDeps, tournament: Tournament, now: Date): Promise<number> {
  const rows = await deps.db
    .select({ matchId: matchConsensus.matchId })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .where(and(eq(matches.tournamentId, tournament.id), inArray(matchConsensus.state, ['agreed', 'pushed_to_purse'])))
    .orderBy(asc(matches.finalizedAt), asc(matches.id));
  let pushed = 0;
  for (const { matchId } of rows) {
    const outcome = await pushMatchScores(deps, { matchId, actor: SYSTEM_ACTOR, requestId: `seed-push-${matchId}`, now, retry: true });
    if (outcome.purse === 'confirmed') pushed += 1;
    else deps.log.warn('seed: a match did not confirm with Purse', { matchId, state: outcome.purse, error: outcome.error });
  }
  return pushed;
}

/** Preview and close a tournament Sideout already recorded as settled, so Purse shows the settled contest. */
async function settleOnPurse(deps: PurseDeps, tournament: Tournament, now: Date): Promise<boolean> {
  const pushed = await pushFinalStandings(deps, tournament, { requestId: `seed-final-${tournament.id}`, now, actor: SYSTEM_ACTOR });
  if (pushed.contest.state === 'settled') return true;
  const preview = (await deps.purse.previewContest(pushed.contest.id, { requestId: `seed-preview-${tournament.id}`, subject: contestSubject(tournament) })).data;
  const frozen = {
    version: 1 as const,
    contestId: preview.contestId,
    payoutHash: preview.payoutHash,
    escrowTotal: preview.escrowTotal,
    entries: preview.entries,
    payouts: preview.payouts,
    standings: pushed.standings,
    contestState: preview.state,
    previewedAt: now.toISOString(),
    previewedByUserId: '',
  };
  const closed = await deps.purse.closeContest(preview.contestId, preview.payoutHash, {
    requestId: `seed-close-${tournament.id}`,
    idempotencyKey: closeKey(tournament, frozen),
    subject: contestSubject(tournament),
  });
  await deps.db.transaction(async (tx) => {
    await tx.update(tournaments).set({ purseClosePreview: frozen, purseContestState: closed.data.contest.state, updatedAt: now }).where(eq(tournaments.id, tournament.id));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'tournament.closed',
      subjectType: 'tournament',
      subjectId: tournament.id,
      detail: { contestId: closed.data.contest.id, payoutHash: closed.data.payoutHash, journalEntryId: closed.data.journalEntryId, results: closed.data.results.map((r) => ({ userId: r.userId, placement: r.placement, payoutAmount: r.payoutAmount })), replayed: closed.replayed, seed: true },
      at: now,
    });
  });
  return closed.data.contest.state === 'settled';
}

export async function seedPurse(deps: PurseDeps, options: { now: Date; log: Logger }): Promise<SeedPurseSummary> {
  const now = options.now;
  const summary: SeedPurseSummary = { linked: 0, tournaments: [] };
  // Every seeded event but the draft, which has no contest yet (a draft is created on Purse when it opens).
  const order = [SEED_SLUGS.settled, SEED_SLUGS.live, SEED_SLUGS.upcoming, SEED_SLUGS.drawn, SEED_SLUGS.cancelled, SEED_SLUGS.communityCup, SEED_SLUGS.boardwalk, SEED_SLUGS.duneCup];
  const rows = await deps.db.select().from(tournaments).where(inArray(tournaments.slug, order));
  for (const slug of order) {
    const tournament = rows.find((t) => t.slug === slug);
    if (tournament === undefined) continue;
    const roster = await deps.db
      .select({ user: users })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(confirmedTeamsFilter(tournament.id));
    summary.linked += await linkPlayers(deps, roster.map((r) => r.user), now);

    // The contest is opened before anything else so entries are accepted, whatever the tournament's status is now.
    let contest = await ensurePurseContest(deps, tournament, { requestId: `seed-contest-${tournament.id}`, now });
    contest = await mirrorContestState(deps, { ...tournament, status: 'registration_open' }, contest, { requestId: `seed-open-${tournament.id}`, now });
    const entered = await enterPlayers(deps, deps.purse, tournament, contest.id);
    const [refreshed] = await deps.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    const current = refreshed ?? tournament;
    await readBackEntries(deps, current, { requestId: `seed-readback-${tournament.id}`, now });
    contest = await mirrorContestState(deps, current, contest, { requestId: `seed-mirror-${tournament.id}`, now });

    let pushed = 0;
    let settled = false;
    if (current.status === 'live' || current.status === 'awaiting_settlement' || current.status === 'settled') {
      const [again] = await deps.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
      pushed = await pushAgreedMatches(deps, again ?? current, now);
    }
    if (current.status === 'settled') {
      const [again] = await deps.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
      settled = await settleOnPurse(deps, again ?? current, now);
    }
    const [final] = await deps.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    summary.tournaments.push({ slug, contestId: contest.id, contestState: final?.purseContestState ?? contest.state, entered, pushed, settled });
    options.log.info('seed: tournament mirrored to Purse', { slug, contestId: contest.id, contestState: final?.purseContestState ?? contest.state, entered, pushed, settled });
  }
  return summary;
}

