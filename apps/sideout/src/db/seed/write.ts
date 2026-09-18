import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import type { Db } from '../client';
import { auditLog, charities, donations, matchConsensus, matches, pools, poolTeams, scoreSubmissions, sets, sponsors, teamMembers, teams, tournaments, users } from '../schema';
import type { SeedDataset } from './build';

/**
 * Persist a seed dataset idempotently: every row is upserted by its id, so a second run
 * changes nothing and a run after local edits restores the seeded rows. Rows the seed
 * does not own (a team someone registered by hand) are left alone. Bracket matches
 * reference each other through `next_match_id`, so they are written once without links
 * and once with them. What Purse decided is not restored: a tournament's contest columns,
 * a user's link and a consensus's push state are left as `purse.ts` (or a live run) set
 * them, so a reseed never claims Purse forgot what it holds.
 */

export type SeedSummary = Record<keyof SeedDataset, number>;

const CHUNK = 200;

async function upsertAll<T extends PgTable>(db: Db, table: T, rows: Array<T['$inferInsert']>, options: { except?: string[] } = {}): Promise<void> {
  if (rows.length === 0) return;
  const columns = getTableColumns(table);
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(columns)) {
    if (key === 'id' || options.except?.includes(key)) continue;
    set[key] = sql.raw(`excluded."${column.name}"`);
  }
  const idColumn = columns['id'];
  if (idColumn === undefined) throw new Error('seed: table has no id column');
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(table)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({ target: idColumn, set });
  }
}

export async function writeSeed(db: Db, dataset: SeedDataset): Promise<SeedSummary> {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await upsertAll(t, charities, dataset.charities);
    await upsertAll(t, users, dataset.users, { except: ['purseUserId', 'purseLinkedAt', 'purseVerificationState'] });
    await upsertAll(t, tournaments, dataset.tournaments, { except: ['purseContestId', 'purseContestState', 'purseClosePreview'] });
    await upsertAll(t, sponsors, dataset.sponsors);
    await upsertAll(t, teams, dataset.teams);
    await upsertAll(t, teamMembers, dataset.teamMembers);
    await upsertAll(t, pools, dataset.pools);
    await upsertAll(t, poolTeams, dataset.poolTeams);
    await upsertAll(
      t,
      matches,
      dataset.matches.map((m) => ({ ...m, nextMatchId: null, nextMatchSlot: null })),
    );
    await upsertAll(t, matches, dataset.matches);
    await upsertAll(t, sets, dataset.sets);
    await upsertAll(t, donations, dataset.donations);
    await upsertAll(t, scoreSubmissions, dataset.scoreSubmissions);
    await upsertAll(t, matchConsensus, dataset.matchConsensus, { except: ['state', 'pushedAt', 'confirmedAt', 'lastPushError', 'resolvedByUserId', 'agreedHash', 'idempotencyKey', 'disputedReason', 'disputedSets'] });
    await upsertAll(t, auditLog, dataset.auditLog);
  });
  return {
    charities: dataset.charities.length,
    users: dataset.users.length,
    tournaments: dataset.tournaments.length,
    sponsors: dataset.sponsors.length,
    teams: dataset.teams.length,
    teamMembers: dataset.teamMembers.length,
    pools: dataset.pools.length,
    poolTeams: dataset.poolTeams.length,
    matches: dataset.matches.length,
    sets: dataset.sets.length,
    donations: dataset.donations.length,
    scoreSubmissions: dataset.scoreSubmissions.length,
    matchConsensus: dataset.matchConsensus.length,
    auditLog: dataset.auditLog.length,
  };
}
