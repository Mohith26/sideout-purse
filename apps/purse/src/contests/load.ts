import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import {
  contestParticipants,
  contestResults,
  contestScores,
  contests,
  type Contest,
  type ContestParticipant,
  type ContestResult,
  type ContestScore,
} from '../db/schema';
import { ContestError } from './errors';

/**
 * Reads the contest services share. Every lookup that takes a `tenantId` refuses another
 * tenant's contest with `contest_wrong_tenant` here, at one boundary, so no service has to
 * remember to.
 */

/** A contest by id, whoever owns it. Every service goes through `getContest`, which adds the tenant check. */
async function findContest(db: DbOrTx, contestId: string): Promise<Contest | undefined> {
  const [row] = await db.select().from(contests).where(eq(contests.id, contestId));
  return row;
}

export async function getContest(db: DbOrTx, tenantId: Id<'tnt'>, contestId: string): Promise<Contest> {
  return assertTenant(await findContest(db, contestId), tenantId, contestId);
}

/**
 * The contest row under `SELECT ... FOR UPDATE` (spec 4.3 MUST). Every write to a contest,
 * its entries or its scores starts here, which is what serialises concurrent entries,
 * concurrent closes and a close racing a late score. Callers hold the lock to the end of
 * their transaction and take account row locks only after it, in id order and in one
 * statement per operation (`postEntry`, or `voidContest`'s up-front lock over every wallet
 * it will refund), so operations on different contests that share wallets wait on each
 * other rather than deadlock.
 */
export async function lockContest(tx: DbOrTx, tenantId: Id<'tnt'>, contestId: string): Promise<Contest> {
  const [row] = await tx.select().from(contests).where(eq(contests.id, contestId)).for('update');
  return assertTenant(row, tenantId, contestId);
}

function assertTenant(row: Contest | undefined, tenantId: Id<'tnt'>, contestId: string): Contest {
  if (row === undefined) throw new ContestError('contest_not_found', `No contest ${contestId}`, { contestId });
  if (row.tenantId !== tenantId) {
    throw new ContestError('contest_wrong_tenant', `Contest ${contestId} belongs to another tenant`, { contestId });
  }
  return row;
}

export async function listParticipants(db: DbOrTx, contestId: string): Promise<ContestParticipant[]> {
  return db.select().from(contestParticipants).where(eq(contestParticipants.contestId, contestId)).orderBy(asc(contestParticipants.joinedAt), asc(contestParticipants.id));
}

/** Participants whose stake is in escrow: everyone but the withdrawn. */
export async function activeParticipants(db: DbOrTx, contestId: string): Promise<ContestParticipant[]> {
  return db
    .select()
    .from(contestParticipants)
    .where(and(eq(contestParticipants.contestId, contestId), inArray(contestParticipants.state, ['entered', 'disqualified'])))
    .orderBy(asc(contestParticipants.joinedAt), asc(contestParticipants.id));
}

export async function findParticipant(db: DbOrTx, contestId: string, userId: string): Promise<ContestParticipant | undefined> {
  const [row] = await db
    .select()
    .from(contestParticipants)
    .where(and(eq(contestParticipants.contestId, contestId), eq(contestParticipants.userId, userId)));
  return row;
}

export async function getParticipant(db: DbOrTx, participantId: string): Promise<ContestParticipant> {
  const [row] = await db.select().from(contestParticipants).where(eq(contestParticipants.id, participantId));
  if (row === undefined) throw new Error(`Participant ${participantId} recorded but not found`);
  return row;
}

/** The counting score per user: the one row per (contest, user) with no successor. */
export async function currentScores(db: DbOrTx, contestId: string): Promise<ContestScore[]> {
  return db
    .select()
    .from(contestScores)
    .where(and(eq(contestScores.contestId, contestId), isNull(contestScores.supersededBy)))
    .orderBy(asc(contestScores.userId));
}

/** Every score ever submitted for a contest, oldest first, superseded rows included. */
export async function scoreHistory(db: DbOrTx, contestId: string): Promise<ContestScore[]> {
  return db.select().from(contestScores).where(eq(contestScores.contestId, contestId)).orderBy(asc(contestScores.submittedAt), asc(contestScores.id));
}

export async function scoresById(db: DbOrTx, ids: readonly string[]): Promise<ContestScore[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(contestScores).where(inArray(contestScores.id, [...ids]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`Score ${id} recorded but not found`);
    return row;
  });
}

export async function listResults(db: DbOrTx, contestId: string): Promise<ContestResult[]> {
  return db.select().from(contestResults).where(eq(contestResults.contestId, contestId)).orderBy(asc(contestResults.placement), asc(contestResults.userId));
}
