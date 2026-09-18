import type { Charity, Match, Pool, PoolTeam, SetRow, Sponsor, Team, TeamMember, Tournament, User } from '../db/schema';
import type { StandingRow } from '../domain/standings';
import { centsToJson } from './money';

/**
 * What the public API says about a tournament. Every field is listed by hand, so a new
 * column is private until someone adds it here, and no `purse_*` identifier can leak:
 * `expectNoPurseKeys` in `test/helpers.ts` walks a public response and fails on any key
 * that mentions Purse, and the route and seed tests apply it to every public shape. Cents
 * are decimal strings (`money.ts`).
 */

export type PublicBeneficiary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
};

export type PublicTournament = {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  beneficiary: PublicBeneficiary;
  venue: { name: string; city: string; region: string; timezone: string };
  startsAt: string;
  endsAt: string;
  format: Tournament['format'];
  division: Tournament['division'];
  maxTeams: number;
  entryDonationCents: string;
  fundraisingGoalCents: string;
  status: Tournament['status'];
  /** Registered and checked-in teams; forming and withdrawn teams are not counted. */
  teamCount: number;
};

export function toPublicTournament(tournament: Tournament, beneficiary: Charity, teamCount: number): PublicTournament {
  return {
    id: tournament.id,
    slug: tournament.slug,
    name: tournament.name,
    subtitle: tournament.subtitle,
    beneficiary: {
      id: beneficiary.id,
      slug: beneficiary.slug,
      name: beneficiary.name,
      description: beneficiary.description,
      websiteUrl: beneficiary.websiteUrl,
      logoUrl: beneficiary.logoUrl,
    },
    venue: {
      name: tournament.venueName,
      city: tournament.venueCity,
      region: tournament.venueRegion,
      timezone: tournament.venueTimezone,
    },
    startsAt: tournament.startsAt.toISOString(),
    endsAt: tournament.endsAt.toISOString(),
    format: tournament.format,
    division: tournament.division,
    maxTeams: tournament.maxTeams,
    entryDonationCents: centsToJson(tournament.entryDonationCents),
    fundraisingGoalCents: centsToJson(tournament.fundraisingGoalCents),
    status: tournament.status,
    teamCount,
  };
}

export type PublicMember = { userId: string; displayName: string; avatarUrl: string | null; role: TeamMember['role'] };

export type PublicTeam = {
  id: string;
  name: string;
  seed: number | null;
  status: Team['status'];
  members: PublicMember[];
};

export function toPublicTeam(team: Team, members: Array<{ member: TeamMember; user: User }>): PublicTeam {
  return {
    id: team.id,
    name: team.name,
    seed: team.seed,
    status: team.status,
    members: members
      .slice()
      .sort((x, y) => (x.member.role === 'captain' ? -1 : 0) - (y.member.role === 'captain' ? -1 : 0) || x.member.createdAt.getTime() - y.member.createdAt.getTime())
      .map(({ member, user }) => ({ userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, role: member.role })),
  };
}

export type PublicSet = { setNumber: number; teamAPoints: number; teamBPoints: number; agreed: boolean };

export type PublicMatch = {
  id: string;
  tournamentId: string;
  poolId: string | null;
  round: number;
  bracketPosition: number | null;
  courtLabel: string | null;
  teamAId: string | null;
  teamBId: string | null;
  teamASeed: number | null;
  teamBSeed: number | null;
  bestOf: number;
  status: Match['status'];
  winnerTeamId: string | null;
  nextMatchId: string | null;
  nextMatchSlot: Match['nextMatchSlot'];
  scheduledAt: string | null;
  startedAt: string | null;
  finalizedAt: string | null;
  sets: PublicSet[];
};

export function toPublicMatch(match: Match, sets: readonly SetRow[]): PublicMatch {
  return {
    id: match.id,
    tournamentId: match.tournamentId,
    poolId: match.poolId,
    round: match.round,
    bracketPosition: match.bracketPosition,
    courtLabel: match.courtLabel,
    teamAId: match.teamAId,
    teamBId: match.teamBId,
    teamASeed: match.teamASeed,
    teamBSeed: match.teamBSeed,
    bestOf: match.bestOf,
    status: match.status,
    winnerTeamId: match.winnerTeamId,
    nextMatchId: match.nextMatchId,
    nextMatchSlot: match.nextMatchSlot,
    scheduledAt: match.scheduledAt?.toISOString() ?? null,
    startedAt: match.startedAt?.toISOString() ?? null,
    finalizedAt: match.finalizedAt?.toISOString() ?? null,
    sets: sets
      .filter((s) => s.matchId === match.id)
      .sort((x, y) => x.setNumber - y.setNumber)
      .map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints, agreed: s.agreed })),
  };
}

export type PublicPool = {
  id: string;
  label: string;
  sequence: number;
  courtLabel: string;
  teams: Array<{ teamId: string; position: number }>;
  matches: PublicMatch[];
  standings: StandingRow[];
};

export function toPublicPool(pool: Pool, poolTeams: readonly PoolTeam[], matches: readonly PublicMatch[], standings: StandingRow[]): PublicPool {
  return {
    id: pool.id,
    label: pool.label,
    sequence: pool.sequence,
    courtLabel: pool.courtLabel,
    teams: poolTeams
      .filter((pt) => pt.poolId === pool.id)
      .sort((x, y) => x.position - y.position)
      .map((pt) => ({ teamId: pt.teamId, position: pt.position })),
    matches: matches.filter((m) => m.poolId === pool.id),
    standings,
  };
}

export type PublicSponsor = { id: string; name: string; logoUrl: string | null; tier: Sponsor['tier']; prizeContributionCents: string };

export function toPublicSponsor(sponsor: Sponsor): PublicSponsor {
  return {
    id: sponsor.id,
    name: sponsor.name,
    logoUrl: sponsor.logoUrl,
    tier: sponsor.tier,
    prizeContributionCents: centsToJson(sponsor.prizeContributionCents),
  };
}

export type PublicBracket = { size: number; rounds: number; matches: PublicMatch[] };

export type PublicTournamentDetail = PublicTournament & {
  teams: PublicTeam[];
  pools: PublicPool[];
  bracket: PublicBracket | null;
  sponsors: PublicSponsor[];
};

/** What a signed-in user sees about themselves. No Purse identifiers here either. */
export type PublicProfile = {
  id: string;
  displayName: string;
  phoneE164: string | null;
  avatarUrl: string | null;
  role: User['role'];
};

export function toPublicProfile(user: User): PublicProfile {
  return { id: user.id, displayName: user.displayName, phoneE164: user.phoneE164, avatarUrl: user.avatarUrl, role: user.role };
}
