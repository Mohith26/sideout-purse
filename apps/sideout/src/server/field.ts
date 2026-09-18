import { and, count, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';

import { donations, teams } from '../db/schema';
import type { DbOrTx } from './db';

/**
 * Which teams hold a place in a tournament's field. A registered team is *confirmed* once
 * its entry donation succeeded (or the entry was free); until then its `pending` donation
 * is a *reservation* that holds the place for `reservationTtlMs` and lapses on its own,
 * judged at read time against the request's clock rather than by a background job.
 * Capacity, the public team list and the live guard count confirmed plus reserving teams;
 * a draw takes only the confirmed ones (docs/decisions.md, "Unpaid reservations lapse").
 */

/** Team statuses that may hold a place; `forming` and `withdrawn` never count. */
export const COUNTED_TEAM_STATUSES = ['registered', 'checked_in'] as const;

/** The moment a registration is judged and how long an unpaid reservation holds a place. */
export type ReservationClock = { now: Date; reservationTtlMs: number };

export function reservationExpiresAt(donation: { createdAt: Date }, clock: ReservationClock): Date {
  return new Date(donation.createdAt.getTime() + clock.reservationTtlMs);
}

/** SQL over `donations`: the row paid for a place. */
export function confirmingDonation(): SQL {
  return sql`${donations.status} = 'succeeded'`;
}

/** SQL over `donations`: the row pays for a place right now, either paid or a reservation that has not lapsed. */
export function placeHoldingDonation(clock: ReservationClock): SQL {
  const cutoff = new Date(clock.now.getTime() - clock.reservationTtlMs).toISOString();
  return sql`(${confirmingDonation()} or (${donations.status} = 'pending' and ${donations.createdAt} > ${cutoff}::timestamptz))`;
}

/** SQL over `teams`: the entry was free (no donation row), or some donation of the team satisfies `paying`. */
function teamPaidBy(paying: SQL): SQL {
  return sql`(
    not exists (select 1 from ${donations} where ${donations.teamId} = ${teams.id})
    or exists (select 1 from ${donations} where ${donations.teamId} = ${teams.id} and ${paying})
  )`;
}

/** SQL over `teams`: the entry donation succeeded, or the entry was free. */
export function confirmedTeam(): SQL {
  return teamPaidBy(confirmingDonation());
}

/** SQL over `teams`: confirmed, or holding a reservation that has not lapsed as of the clock. */
export function placeHoldingTeam(clock: ReservationClock): SQL {
  return teamPaidBy(placeHoldingDonation(clock));
}

/** SQL over `teams`, as a boolean: counts toward capacity as of the clock. */
export function holdsPlace(clock: ReservationClock): SQL<boolean> {
  return sql<boolean>`(${inArray(teams.status, [...COUNTED_TEAM_STATUSES])} and ${placeHoldingTeam(clock)})`;
}

export function countedTeamsFilter(tournamentId: string, clock: ReservationClock): SQL | undefined {
  return and(eq(teams.tournamentId, tournamentId), inArray(teams.status, [...COUNTED_TEAM_STATUSES]), placeHoldingTeam(clock));
}

export function confirmedTeamsFilter(tournamentId: string): SQL | undefined {
  return and(eq(teams.tournamentId, tournamentId), inArray(teams.status, [...COUNTED_TEAM_STATUSES]), confirmedTeam());
}

/** Teams holding a place, optionally leaving one team out (the one whose payment is being judged). */
export async function countedTeams(db: DbOrTx, tournamentId: string, clock: ReservationClock, options: { excluding?: string } = {}): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(teams)
    .where(options.excluding === undefined ? countedTeamsFilter(tournamentId, clock) : and(countedTeamsFilter(tournamentId, clock), ne(teams.id, options.excluding)));
  return row?.n ?? 0;
}

export async function teamHoldsPlace(db: DbOrTx, teamId: string, clock: ReservationClock): Promise<boolean> {
  const [row] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), inArray(teams.status, [...COUNTED_TEAM_STATUSES]), placeHoldingTeam(clock)));
  return row !== undefined;
}
