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

/**
 * Raised when the database holds an older generation of the seed.
 *
 * The upserts below key on `id`, and the ids are deterministic — but only for a given
 * dataset. They are minted from one counter and one seeded RNG as the dataset is built, so
 * adding a tournament, or a team, or reordering the build shifts the stream and every id
 * after that point changes. A database seeded before such a change therefore holds the
 * same rows under different ids, and the insert collides on a natural key instead
 * (`tournaments_slug_key`), which surfaces as a page of SQL and no indication of what to
 * do about it.
 *
 * Cleaning it up automatically is not open to us: no foreign key in this schema cascades,
 * so deleting a stale tournament would mean hand-deleting its matches, consensus rows,
 * submissions, sets, pools, teams and audit trail, and a seed script is the wrong place to
 * be deleting a developer's data by inference. So this says plainly what happened and what
 * to run.
 */
export class StaleSeedError extends Error {
  constructor(readonly slugs: string[]) {
    super(
      `the database holds an older generation of the seed: ${slugs.join(', ')} ${slugs.length === 1 ? 'exists' : 'exist'} under ${slugs.length === 1 ? 'a different id' : 'different ids'}.\n` +
        'Seed ids are derived from the dataset, so changing the dataset changes them, and the rows cannot be matched up again.\n' +
        'Reset the Sideout database and seed it fresh:\n' +
        '  psql -d postgres -c \'DROP DATABASE IF EXISTS "sideout"\' && pnpm db:setup && pnpm db:migrate && pnpm db:seed',
    );
    this.name = 'StaleSeedError';
  }
}

/**
 * Fail early, and legibly, when the database was seeded from a different dataset. Compares
 * the tournament slugs — the seed's stable natural key — against the ids they are being
 * written under.
 */
async function assertSeedGeneration(db: Db, dataset: SeedDataset): Promise<void> {
  if (dataset.tournaments.length === 0) return;
  const existing = await db.select({ id: tournaments.id, slug: tournaments.slug }).from(tournaments);
  if (existing.length === 0) return;
  const expected = new Map(dataset.tournaments.map((t) => [t.slug, t.id]));
  const stale = existing.filter((row) => expected.has(row.slug) && expected.get(row.slug) !== row.id).map((row) => row.slug);
  if (stale.length > 0) throw new StaleSeedError(stale.sort());
}

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
  await assertSeedGeneration(db, dataset);
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
