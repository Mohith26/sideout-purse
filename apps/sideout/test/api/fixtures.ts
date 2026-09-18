import { newId } from '@repo/ids';

import { teamMembers, teams, type Charity } from '../../src/db/schema';
import { createUser, type Database } from '../helpers';

/**
 * Fixtures the route tests share. In a file of its own so importing one does not run
 * another file's tests along with it.
 */
export const SOON = new Date(Date.now() + 14 * 24 * 3600 * 1000);

export function tournamentBody(charity: Charity, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'sandbar-classic-2027',
    name: 'Sandbar Classic',
    subtitle: 'The flagship',
    beneficiaryId: charity.id,
    venue: { name: 'Sandbar Courts', city: 'Santa Cruz', region: 'CA', timezone: 'America/Los_Angeles' },
    startsAt: SOON.toISOString(),
    endsAt: new Date(SOON.getTime() + 8 * 3600 * 1000).toISOString(),
    format: 'pool_to_bracket',
    division: 'open',
    maxTeams: 24,
    entryDonationCents: '5000',
    fundraisingGoalCents: '500000',
    ...overrides,
  };
}

/** Registered teams inserted directly: the registration flow has its own tests. */
export async function registerTeams(database: Database, tournamentId: string, n: number, seeds: Record<number, number> = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const captain = await createUser(database, { displayName: `Captain ${i + 1}` });
    const player = await createUser(database, { displayName: `Player ${i + 1}` });
    const [team] = await database.db
      .insert(teams)
      .values({ id: newId('tm'), tournamentId, name: `Team ${i + 1}`, status: 'registered', registeredAt: new Date(), seed: seeds[i] ?? null })
      .returning();
    if (team === undefined) throw new Error('team insert failed');
    await database.db.insert(teamMembers).values([
      { id: newId('tmm'), teamId: team.id, userId: captain.id, role: 'captain' },
      { id: newId('tmm'), teamId: team.id, userId: player.id, role: 'player' },
    ]);
    ids.push(team.id);
  }
  return ids;
}
