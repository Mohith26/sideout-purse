import type { TeamRole } from '../db/schema';

/** Beach volleyball is 2v2: a team is exactly two distinct players, one of them captain. */
export const TEAM_SIZE = 2;

export type RosterMember = { userId: string; role: TeamRole };

export type RosterVerdict = { ok: true } | { ok: false; reason: string };

export function checkTeamRoster(members: readonly RosterMember[]): RosterVerdict {
  if (members.length !== TEAM_SIZE) {
    return { ok: false, reason: `A team has exactly ${TEAM_SIZE} members; got ${members.length}.` };
  }
  const users = new Set(members.map((m) => m.userId));
  if (users.size !== members.length) {
    return { ok: false, reason: 'A player cannot be on the same team twice.' };
  }
  const captains = members.filter((m) => m.role === 'captain').length;
  if (captains !== 1) {
    return { ok: false, reason: `A team has exactly one captain; got ${captains}.` };
  }
  return { ok: true };
}

/** Throwing form for write paths (the seed, and the services that change a roster). */
export function assertTeamRoster(members: readonly RosterMember[]): void {
  const verdict = checkTeamRoster(members);
  if (!verdict.ok) throw new Error(`Invalid team roster: ${verdict.reason}`);
}
