import { and, asc, count, eq, inArray, ne, sql, sum } from 'drizzle-orm';

import { charities, donations, matches, pools, sets, teamMembers, teams, tournaments, users, type Charity, type Match, type MatchStatus, type Tournament, type TournamentStatus } from '../db/schema';
import { isMatchComplete } from '../domain/state';
import type { DbOrTx } from './db';
import { COUNTED_TEAM_STATUSES, countedTeamsFilter, placeHoldingTeam, type ReservationClock } from './field';
import { centsToJson } from './money';
import { toPublicMatch, toPublicTeam, toPublicTournament, type PublicMatch, type PublicTeam, type PublicTournament } from './public-shape';
import { teamMembersWithUsers } from './teams';

/**
 * Read models for the screens (spec 5.3): the event summaries Home and the events list
 * render, the matches on the sand, the schedule and courts an overview shows, and the
 * court-by-court board the organizer works from. Every figure is derived from rows
 * (spec 7): raised is the sum of succeeded donations net of refunds, a team count is the
 * counted set under the reservation rule, a live count is the matches `in_progress`.
 */
export type TournamentSummary = {
  tournament: PublicTournament;
  /** Succeeded donations net of partial refunds, in cents of the donation currency. */
  raisedCents: string;
  donorCount: number;
  liveMatchCount: number;
  currency: string;
};

const netCents = sql<string>`${donations.amountCents} - ${donations.refundedCents}`;

/** Every tournament the public may see (or every one at all, for the organizer), with what each raised and what is on court. */
export async function listTournamentSummaries(db: DbOrTx, clock: ReservationClock, options: { includeDrafts?: boolean } = {}): Promise<TournamentSummary[]> {
  const rows = await db
    .select({ tournament: tournaments, beneficiary: charities })
    .from(tournaments)
    .innerJoin(charities, eq(charities.id, tournaments.beneficiaryId))
    .where(options.includeDrafts === true ? undefined : ne(tournaments.status, 'draft'))
    .orderBy(asc(tournaments.startsAt), asc(tournaments.id));
  const ids = rows.map((r) => r.tournament.id);
  if (ids.length === 0) return [];
  const teamRows = await db
    .select({ tournamentId: teams.tournamentId, n: count() })
    .from(teams)
    .where(and(inArray(teams.tournamentId, ids), inArray(teams.status, [...COUNTED_TEAM_STATUSES]), placeHoldingTeam(clock)))
    .groupBy(teams.tournamentId);
  const raisedRows = await db
    .select({ tournamentId: donations.tournamentId, raised: sum(netCents), n: count(), currency: donations.currency })
    .from(donations)
    .where(and(inArray(donations.tournamentId, ids), eq(donations.status, 'succeeded')))
    .groupBy(donations.tournamentId, donations.currency);
  const liveRows = await db
    .select({ tournamentId: matches.tournamentId, n: count() })
    .from(matches)
    .where(and(inArray(matches.tournamentId, ids), eq(matches.status, 'in_progress')))
    .groupBy(matches.tournamentId);
  const teamCount = new Map(teamRows.map((r) => [r.tournamentId, r.n]));
  const raised = new Map(raisedRows.map((r) => [r.tournamentId, r]));
  const live = new Map(liveRows.map((r) => [r.tournamentId, r.n]));
  return rows.map(({ tournament, beneficiary }) => {
    const r = raised.get(tournament.id);
    return {
      tournament: toPublicTournament(tournament, beneficiary, teamCount.get(tournament.id) ?? 0),
      raisedCents: centsToJson(BigInt(r?.raised ?? '0')),
      donorCount: r?.n ?? 0,
      liveMatchCount: live.get(tournament.id) ?? 0,
      currency: r?.currency ?? 'USD',
    };
  });
}

export async function tournamentSummary(db: DbOrTx, tournament: Tournament, beneficiary: Charity, clock: ReservationClock): Promise<TournamentSummary> {
  const [teamRow] = await db.select({ n: count() }).from(teams).where(countedTeamsFilter(tournament.id, clock));
  const [raisedRow] = await db
    .select({ raised: sum(netCents), n: count() })
    .from(donations)
    .where(and(eq(donations.tournamentId, tournament.id), eq(donations.status, 'succeeded')));
  const [liveRow] = await db.select({ n: count() }).from(matches).where(and(eq(matches.tournamentId, tournament.id), eq(matches.status, 'in_progress')));
  return {
    tournament: toPublicTournament(tournament, beneficiary, teamRow?.n ?? 0),
    raisedCents: centsToJson(BigInt(raisedRow?.raised ?? '0')),
    donorCount: raisedRow?.n ?? 0,
    liveMatchCount: liveRow?.n ?? 0,
    currency: 'USD',
  };
}

// ---- Matches with their teams ----------------------------------------------------------------

export type MatchView = {
  match: PublicMatch;
  teamA: PublicTeam | null;
  teamB: PublicTeam | null;
  poolLabel: string | null;
};

async function viewsFor(db: DbOrTx, rows: Array<{ match: Match; poolLabel: string | null }>): Promise<MatchView[]> {
  if (rows.length === 0) return [];
  const matchIds = rows.map((r) => r.match.id);
  const setRows = await db.select().from(sets).where(inArray(sets.matchId, matchIds));
  const teamIds = [...new Set(rows.flatMap((r) => [r.match.teamAId, r.match.teamBId]).filter((id): id is string => id !== null))];
  const teamRows = teamIds.length === 0 ? [] : await db.select().from(teams).where(inArray(teams.id, teamIds));
  const members = await teamMembersWithUsers(db, teamIds);
  const publicTeam = (id: string | null): PublicTeam | null => {
    const team = teamRows.find((t) => t.id === id);
    return team === undefined ? null : toPublicTeam(team, members.filter((m) => m.member.teamId === team.id));
  };
  return rows.map(({ match, poolLabel }) => ({ match: toPublicMatch(match, setRows), teamA: publicTeam(match.teamAId), teamB: publicTeam(match.teamBId), poolLabel }));
}

const LIVE_STATUSES: readonly MatchStatus[] = ['in_progress', 'awaiting_scores', 'disputed'];

/** What is on the sand and what is waiting for a result, in play first, then by schedule. */
export async function listLiveMatches(db: DbOrTx, tournamentId: string): Promise<MatchView[]> {
  const rows = await db
    .select({ match: matches, poolLabel: pools.label })
    .from(matches)
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .where(and(eq(matches.tournamentId, tournamentId), inArray(matches.status, [...LIVE_STATUSES])))
    .orderBy(asc(matches.scheduledAt), asc(matches.id));
  const order = new Map(LIVE_STATUSES.map((s, i) => [s, i]));
  const views = await viewsFor(db, rows);
  return views.sort((x, y) => (order.get(x.match.status) ?? 9) - (order.get(y.match.status) ?? 9));
}

/** Every match of a tournament with its teams, in schedule order. */
export async function listMatchViews(db: DbOrTx, tournamentId: string): Promise<MatchView[]> {
  const rows = await db
    .select({ match: matches, poolLabel: pools.label })
    .from(matches)
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .where(eq(matches.tournamentId, tournamentId))
    .orderBy(asc(matches.scheduledAt), asc(matches.round), asc(matches.bracketPosition), asc(matches.id));
  return viewsFor(db, rows);
}

export function bracketRoundCount(views: readonly MatchView[]): number {
  return views.reduce((max, v) => (v.match.bracketPosition === null ? max : Math.max(max, v.match.round)), 0);
}

// ---- Overview: schedule rounds and courts ---------------------------------------------------

export type RoundView = {
  key: string;
  label: string;
  startsAt: string | null;
  courts: string[];
  total: number;
  byStatus: Partial<Record<MatchStatus, number>>;
};

/** The schedule as rounds: pool rounds, then bracket rounds by name, each with its start, courts and how far along it is. */
export function scheduleRounds(views: readonly MatchView[], bracketRounds: number, roundLabel: (round: number, total: number) => string): RoundView[] {
  const groups = new Map<string, RoundView>();
  for (const view of views) {
    const { match } = view;
    const pool = match.poolId !== null;
    const key = pool ? `pool-${match.round}` : `bracket-${match.round}`;
    const existing = groups.get(key) ?? { key, label: pool ? `Pool round ${match.round}` : roundLabel(match.round, bracketRounds), startsAt: null, courts: [], total: 0, byStatus: {} };
    existing.total += 1;
    existing.byStatus[match.status] = (existing.byStatus[match.status] ?? 0) + 1;
    if (match.scheduledAt !== null && (existing.startsAt === null || match.scheduledAt < existing.startsAt)) existing.startsAt = match.scheduledAt;
    if (match.courtLabel !== null && !existing.courts.includes(match.courtLabel)) existing.courts.push(match.courtLabel);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((x, y) => {
    const xp = x.key.startsWith('pool') ? 0 : 1;
    const yp = y.key.startsWith('pool') ? 0 : 1;
    if (xp !== yp) return xp - yp;
    return (x.startsAt ?? '').localeCompare(y.startsAt ?? '') || x.key.localeCompare(y.key);
  });
}

// ---- Court board -------------------------------------------------------------------------

export type CourtBoardGroup = { courtLabel: string; matches: MatchView[]; currentMatchId: string | null; byStatus: Partial<Record<MatchStatus, number>> };

export type CourtBoard = { courts: CourtBoardGroup[]; byStatus: Partial<Record<MatchStatus, number>>; bracketRounds: number };

const CURRENT_PRIORITY: Partial<Record<MatchStatus, number>> = { in_progress: 0, awaiting_scores: 1, disputed: 2, scheduled: 3 };

/** Every match on every court in schedule order, what each court is playing now, and the counts by status. */
export function courtBoard(views: readonly MatchView[]): CourtBoard {
  const byCourt = new Map<string, MatchView[]>();
  const byStatus: Partial<Record<MatchStatus, number>> = {};
  for (const view of views) {
    if (view.match.status === 'bye') continue;
    const court = view.match.courtLabel ?? 'Unassigned';
    byCourt.set(court, [...(byCourt.get(court) ?? []), view]);
    byStatus[view.match.status] = (byStatus[view.match.status] ?? 0) + 1;
  }
  const courts = [...byCourt.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([courtLabel, list]) => {
      const counts: Partial<Record<MatchStatus, number>> = {};
      for (const v of list) counts[v.match.status] = (counts[v.match.status] ?? 0) + 1;
      const current = [...list].filter((v) => CURRENT_PRIORITY[v.match.status] !== undefined && (v.match.status !== 'scheduled' || (v.teamA !== null && v.teamB !== null))).sort((x, y) => (CURRENT_PRIORITY[x.match.status] ?? 9) - (CURRENT_PRIORITY[y.match.status] ?? 9))[0];
      return { courtLabel, matches: list, currentMatchId: current?.match.id ?? null, byStatus: counts };
    });
  return { courts, byStatus, bracketRounds: bracketRoundCount(views) };
}

// ---- Disputes count for the console badge ---------------------------------------------------

export async function countDisputedMatches(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: count() }).from(matches).where(eq(matches.status, 'disputed'));
  return row?.n ?? 0;
}

// ---- The viewer's team in an event --------------------------------------------------------

export async function viewerTeamId(db: DbOrTx, tournamentId: string, userId: string | null): Promise<string | null> {
  if (userId === null) return null;
  const [row] = await db
    .select({ id: teams.id })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), eq(teams.tournamentId, tournamentId), ne(teams.status, 'withdrawn')))
    .limit(1);
  return row?.id ?? null;
}

// ---- Profile history ------------------------------------------------------------------------

export type MatchHistoryRow = {
  matchId: string;
  roundLabel: string;
  status: MatchStatus;
  opponentName: string | null;
  won: boolean | null;
  sets: Array<{ mine: number; theirs: number }>;
};

export type TeamHistory = {
  teamId: string;
  played: number;
  wins: number;
  losses: number;
  poolLabel: string | null;
  poolRank: number | null;
  bracketRoundReached: string | null;
  champion: boolean;
  matches: MatchHistoryRow[];
};

/** How a team's event went, from rows: record, pool finish, bracket run and every match, most recent first. */
export function teamHistory(teamId: string, views: readonly MatchView[], poolRank: { label: string; rank: number } | null, roundLabel: (round: number, total: number) => string): TeamHistory {
  const bracketRounds = bracketRoundCount(views);
  const mine = views.filter((v) => v.match.teamAId === teamId || v.match.teamBId === teamId);
  let wins = 0;
  let losses = 0;
  let deepest: number | null = null;
  let champion = false;
  const rows: MatchHistoryRow[] = mine.map((v) => {
    const { match } = v;
    const isA = match.teamAId === teamId;
    const opponent = isA ? v.teamB : v.teamA;
    const won = match.winnerTeamId === null ? null : match.winnerTeamId === teamId;
    if (isMatchComplete(match.status) && match.status !== 'bye') {
      if (won === true) wins += 1;
      else if (won === false) losses += 1;
    }
    if (match.bracketPosition !== null) {
      deepest = deepest === null ? match.round : Math.max(deepest, match.round);
      if (match.round === bracketRounds && won === true) champion = true;
    }
    return {
      matchId: match.id,
      roundLabel: match.poolId !== null ? `${v.poolLabel ?? 'Pool'} · round ${match.round}` : roundLabel(match.round, bracketRounds),
      status: match.status,
      opponentName: opponent?.name ?? null,
      won,
      sets: match.status === 'disputed' ? [] : match.sets.map((s) => ({ mine: isA ? s.teamAPoints : s.teamBPoints, theirs: isA ? s.teamBPoints : s.teamAPoints })),
    };
  });
  return {
    teamId,
    played: wins + losses,
    wins,
    losses,
    poolLabel: poolRank?.label ?? null,
    poolRank: poolRank?.rank ?? null,
    bracketRoundReached: deepest === null ? null : roundLabel(deepest, bracketRounds),
    champion,
    matches: rows.reverse(),
  };
}

/** The roster of every team in a tournament, for tables that show names beside ids. */
export async function rosterOf(db: DbOrTx, tournamentId: string): Promise<Map<string, Array<{ displayName: string }>>> {
  const rows = await db
    .select({ teamId: teamMembers.teamId, displayName: users.displayName, role: teamMembers.role, createdAt: teamMembers.createdAt })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teams.tournamentId, tournamentId))
    .orderBy(asc(teamMembers.createdAt));
  const out = new Map<string, Array<{ displayName: string }>>();
  for (const row of rows.sort((x, y) => (x.role === 'captain' ? -1 : 0) - (y.role === 'captain' ? -1 : 0) || x.createdAt.getTime() - y.createdAt.getTime())) {
    out.set(row.teamId, [...(out.get(row.teamId) ?? []), { displayName: row.displayName }]);
  }
  return out;
}

export const UPCOMING_STATUSES: readonly TournamentStatus[] = ['registration_open', 'registration_closed'];
export const PAST_STATUSES: readonly TournamentStatus[] = ['awaiting_settlement', 'settled', 'cancelled'];
