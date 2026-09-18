import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../db/client';
import { matches, sets, teams, tournaments, type Match } from '../db/schema';
import { advanceWinner, BracketError, forfeitWinner } from '../domain/bracket';
import { validateMatchTransition } from '../domain/state';
import type { Actor } from './actor';
import { writeAudit } from './audit';
import type { DbOrTx } from './db';
import { failure } from './http/errors';
import { toPublicMatch, toPublicTeam, type PublicMatch, type PublicTeam } from './public-shape';
import { teamMembersWithUsers } from './teams';

export type MatchView = {
  match: PublicMatch;
  tournament: { id: string; slug: string; name: string; status: string };
  teamA: PublicTeam | null;
  teamB: PublicTeam | null;
  nextMatch: { id: string; round: number; bracketPosition: number | null } | null;
};

/** One match with its teams. Matches of a draft tournament are as invisible as the draft. */
export async function matchView(db: DbOrTx, matchId: string): Promise<MatchView | null> {
  const [row] = await db
    .select({ match: matches, tournament: tournaments })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(eq(matches.id, matchId));
  if (row === undefined || row.tournament.status === 'draft') return null;

  const setRows = await db.select().from(sets).where(eq(sets.matchId, row.match.id));
  const teamIds = [row.match.teamAId, row.match.teamBId].filter((id): id is string => id !== null);
  const teamRows = teamIds.length === 0 ? [] : await db.select().from(teams).where(inArray(teams.id, teamIds));
  const members = await teamMembersWithUsers(db, teamIds);
  const publicTeam = (id: string | null): PublicTeam | null => {
    const team = teamRows.find((t) => t.id === id);
    return team === undefined ? null : toPublicTeam(team, members.filter((m) => m.member.teamId === team.id));
  };
  const [next] =
    row.match.nextMatchId === null
      ? []
      : await db.select({ id: matches.id, round: matches.round, bracketPosition: matches.bracketPosition }).from(matches).where(eq(matches.id, row.match.nextMatchId));

  return {
    match: toPublicMatch(row.match, setRows),
    tournament: { id: row.tournament.id, slug: row.tournament.slug, name: row.tournament.name, status: row.tournament.status },
    teamA: publicTeam(row.match.teamAId),
    teamB: publicTeam(row.match.teamBId),
    nextMatch: next ?? null,
  };
}

export const forfeitSchema = z.object({ forfeitingTeamId: z.string().startsWith('tm_') });

export type ForfeitResult = { match: Match; winnerTeamId: string; advancedTo: { matchId: string; slot: 'a' | 'b' } | null };

/**
 * The organizer's forfeit: the other team wins, the match is complete, and in a bracket
 * the winner advances through `advanceWinner`, the same function phase 7's consensus
 * uses when a match becomes final.
 */
export async function forfeitMatch(db: Db, input: { matchId: string; forfeitingTeamId: string; actor: Actor; now: Date }): Promise<ForfeitResult> {
  if (input.actor.kind !== 'organizer') throw failure.permission('organizer_required', 'Only an organizer can record a forfeit.');
  return db.transaction(async (tx) => {
    const [match] = await tx.select().from(matches).where(eq(matches.id, input.matchId)).for('update');
    if (match === undefined) throw failure.notFound('match_not_found', 'No such match.');

    const verdict = validateMatchTransition(match.status, 'forfeited', input.actor.kind);
    if (!verdict.ok) throw failure.invalidState(`transition_${verdict.code}`, verdict.message, { from: match.status, to: 'forfeited' });
    if (match.teamAId === null || match.teamBId === null) {
      throw failure.invalidState('match_not_populated', 'Both teams must be known before a forfeit can be recorded.');
    }

    let winnerTeamId: string;
    try {
      winnerTeamId = forfeitWinner(match, input.forfeitingTeamId);
    } catch (error) {
      if (error instanceof BracketError) throw failure.invalidRequest('not_a_participant', error.message);
      throw error;
    }

    const [updated] = await tx
      .update(matches)
      .set({ status: 'forfeited', winnerTeamId, finalizedAt: input.now, updatedAt: input.now })
      .where(eq(matches.id, match.id))
      .returning();
    if (updated === undefined) throw new Error('match update returned no row');

    const advancement = advanceWinner(match, winnerTeamId);
    let advancedTo: ForfeitResult['advancedTo'] = null;
    if (advancement !== null) {
      await tx
        .update(matches)
        .set(
          advancement.slot === 'a'
            ? { teamAId: winnerTeamId, teamASeed: advancement.seed, updatedAt: input.now }
            : { teamBId: winnerTeamId, teamBSeed: advancement.seed, updatedAt: input.now },
        )
        .where(eq(matches.id, advancement.nextMatchId));
      advancedTo = { matchId: advancement.nextMatchId, slot: advancement.slot };
    }

    await writeAudit(tx, {
      actor: input.actor,
      action: 'match.forfeited',
      subjectType: 'match',
      subjectId: match.id,
      detail: { from: match.status, forfeitingTeamId: input.forfeitingTeamId, winnerTeamId, advancedTo },
      at: input.now,
    });
    return { match: updated, winnerTeamId, advancedTo };
  });
}
