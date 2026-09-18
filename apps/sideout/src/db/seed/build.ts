import { v7 as uuidv7 } from 'uuid';
import type { Id, IdPrefix } from '@repo/ids';

import type {
  BestOf,
  MatchStatus,
  NewAuditLogEntry,
  NewCharity,
  NewDonation,
  NewMatch,
  NewPool,
  NewPoolTeam,
  NewSetRow,
  NewSponsor,
  NewTeam,
  NewTeamMember,
  NewTournament,
  NewUser,
  TournamentStatus,
} from '../schema';
import { advanceWinner } from '../../domain/bracket';
import { drawBracket, drawPools, rankForBracket, type BracketDraw, type DrawTeam } from '../../domain/draw';
import { DRAW_CONFIG_VERSION, type PoolToBracketConfig } from '../../domain/draw-config';
import { createRng, type Rng } from '../../domain/rng';
import { DECIDING_SET_TARGET, judgeMatch, judgeSet, setTarget, type SetScore, type Side } from '../../domain/scoreline';
import { computeStandings, type StandingsMatch } from '../../domain/standings';
import { assertTeamRoster } from '../../domain/team';
import { ORGANIZER_NAMES, PLAYER_NAMES } from './names';

/**
 * The seed dataset as plain rows. Pure and deterministic: the same `anchor` and `rngSeed`
 * produce byte-identical output, ids never depend on the anchor, and every figure that
 * ends up on screen (standings, bracket seeds, winners, impact totals) follows from these
 * rows rather than being typed. The pools and brackets come from the same draw engine the
 * organizer's draw endpoint uses, and every set is checked by the scoreline rules, so the
 * seed and the engine cannot disagree.
 *
 * Nothing here touches the database; `write.ts` persists the result idempotently.
 */

export type SeedOptions = {
  /** The moment the live event is "in progress": its start time. Other events hang off it. */
  anchor: Date;
  rngSeed?: number;
};

export type SeedDataset = {
  charities: NewCharity[];
  users: NewUser[];
  tournaments: NewTournament[];
  sponsors: NewSponsor[];
  teams: NewTeam[];
  teamMembers: NewTeamMember[];
  pools: NewPool[];
  poolTeams: NewPoolTeam[];
  matches: NewMatch[];
  sets: NewSetRow[];
  donations: NewDonation[];
  auditLog: NewAuditLogEntry[];
};

export const SEED_RNG_SEED = 0x51de_0f7;
export const SEED_CHARITY_SLUG = 'open-court-project';
export const SEED_SLUGS = { live: 'sandbar-classic-2026', upcoming: 'pier-9-open-2026', settled: 'low-tide-open-2026' } as const;
/** `+1 415 555-01xx`: the reserved fictional range, never a real subscriber. */
export const SEED_PHONE_PREFIX = '+1415555';
export const SEED_ORGANIZER_PHONE = `${SEED_PHONE_PREFIX}0100`;
export const SEED_CURRENCY = 'USD';
export const VENUE_TIMEZONE = 'America/Los_Angeles';

/** Ids embed a counter from this epoch, not the anchor, so a re-anchored seed keeps its ids. */
const SEED_ID_EPOCH = Date.UTC(2026, 0, 1);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The same slot lengths `server/draw.ts` schedules with. */
const POOL_MATCH_MINUTES = 30;
const BRACKET_MATCH_MINUTES = 45;
const STAGE_BREAK_MINUTES = 15;

type SeedUser = { row: NewUser; strength: number };
type SeedTeam = { row: NewTeam; captain: SeedUser; player: SeedUser; strength: number };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function pairName(captain: string, player: string): string {
  const last = (name: string) => name.split(' ').slice(-1)[0] ?? name;
  return `${last(captain)} / ${last(player)}`;
}

class SeedBuilder {
  readonly rng: Rng;
  private idClock = SEED_ID_EPOCH;
  readonly data: SeedDataset = {
    charities: [],
    users: [],
    tournaments: [],
    sponsors: [],
    teams: [],
    teamMembers: [],
    pools: [],
    poolTeams: [],
    matches: [],
    sets: [],
    donations: [],
    auditLog: [],
  };

  constructor(
    readonly anchor: Date,
    rngSeed: number,
  ) {
    this.rng = createRng(rngSeed);
  }

  at(offsetMs: number): Date {
    return new Date(this.anchor.getTime() + offsetMs);
  }

  /** A UUID v7 id with a monotonic timestamp and rng entropy: stable across runs. */
  mint<P extends IdPrefix>(prefix: P): Id<P> {
    this.idClock += 1;
    return `${prefix}_${uuidv7({ msecs: this.idClock, random: this.rng.bytes(16) })}`;
  }

  opaque(kind: 'user' | 'contest'): string {
    return `sideout-${kind}-${hex(this.rng.bytes(16))}`;
  }

  audit(entry: Omit<NewAuditLogEntry, 'id'>): void {
    this.data.auditLog.push({ id: this.mint('aud'), ...entry });
  }

  // ---- people ------------------------------------------------------------------------

  buildCharity(): NewCharity {
    const created = this.at(-120 * DAY);
    const charity: NewCharity = {
      id: this.mint('chr'),
      slug: SEED_CHARITY_SLUG,
      name: 'Open Court Project',
      description:
        'Keeps public beach volleyball courts free to play on, funding nets, lights and volunteer coaching so kids in coastal neighbourhoods learn the game without club fees.',
      websiteUrl: 'https://opencourt.example.org',
      logoUrl: null,
      status: 'active',
      createdAt: created,
      updatedAt: created,
    };
    this.data.charities.push(charity);
    return charity;
  }

  buildUsers(): { organizers: SeedUser[]; players: SeedUser[] } {
    const base = this.at(-110 * DAY);
    const make = (first: string, last: string, index: number, role: NewUser['role']): SeedUser => {
      const createdAt = new Date(base.getTime() + index * 17 * HOUR + this.rng.int(0, 6 * HOUR));
      return {
        strength: this.rng.next() * 2 - 1,
        row: {
          id: this.mint('sou'),
          purseExternalId: this.opaque('user'),
          displayName: `${first} ${last}`,
          phoneE164: `${SEED_PHONE_PREFIX}${String(100 + index).padStart(4, '0')}`,
          avatarUrl: null,
          role,
          createdAt,
          updatedAt: createdAt,
        },
      };
    };
    const organizers = ORGANIZER_NAMES.map(([first, last], i) => make(first, last, i, 'organizer'));
    const players = PLAYER_NAMES.map(([first, last], i) => make(first, last, ORGANIZER_NAMES.length + i, 'player'));
    this.data.users.push(...organizers.map((u) => u.row), ...players.map((u) => u.row));
    return { organizers, players };
  }

  // ---- tournaments ---------------------------------------------------------------------

  tournament(input: Omit<NewTournament, 'id' | 'purseExternalId' | 'purseContestId' | 'venueTimezone' | 'updatedAt'>, organizer: SeedUser): NewTournament {
    const row: NewTournament = {
      ...input,
      id: this.mint('trn'),
      venueTimezone: VENUE_TIMEZONE,
      purseExternalId: this.opaque('contest'),
      purseContestId: null,
      updatedAt: input.createdAt,
    };
    this.data.tournaments.push(row);
    this.audit({
      actorKind: 'organizer',
      actorUserId: organizer.row.id,
      action: 'tournament.created',
      subjectType: 'tournament',
      subjectId: row.id,
      detail: { slug: row.slug, format: row.format, status: 'draft' },
      createdAt: input.createdAt,
    });
    return row;
  }

  transitions(t: NewTournament, organizer: SeedUser, steps: ReadonlyArray<readonly [TournamentStatus, TournamentStatus, Date, 'organizer' | 'system']>): void {
    for (const [from, to, at, actor] of steps) {
      this.audit({
        actorKind: actor,
        actorUserId: actor === 'organizer' ? organizer.row.id : null,
        action: 'tournament.status_changed',
        subjectType: 'tournament',
        subjectId: t.id,
        detail: { from, to },
        createdAt: at,
      });
    }
  }

  // ---- teams ---------------------------------------------------------------------------

  buildTeams(
    t: NewTournament,
    pairs: ReadonlyArray<readonly [SeedUser, SeedUser]>,
    options: { status: NewTeam['status']; registeredFrom: Date; registeredTo: Date; seeded: number },
  ): SeedTeam[] {
    const spacing = Math.max(1, Math.floor((options.registeredTo.getTime() - options.registeredFrom.getTime()) / Math.max(1, pairs.length)));
    const teams: SeedTeam[] = pairs.map(([captain, player], i) => {
      const createdAt = new Date(options.registeredFrom.getTime() + i * spacing + this.rng.int(0, Math.max(0, spacing - 1)));
      const registered = options.status === 'registered' || options.status === 'checked_in';
      const row: NewTeam = {
        id: this.mint('tm'),
        tournamentId: t.id,
        name: pairName(captain.row.displayName, player.row.displayName),
        seed: null,
        status: options.status,
        invitedPhoneE164: player.row.phoneE164 ?? null,
        registeredAt: registered ? new Date(createdAt.getTime() + this.rng.int(2, 30) * MINUTE) : null,
        createdAt,
        updatedAt: createdAt,
      };
      const members: NewTeamMember[] = [
        { id: this.mint('tmm'), teamId: row.id, userId: captain.row.id, role: 'captain', createdAt },
        { id: this.mint('tmm'), teamId: row.id, userId: player.row.id, role: 'player', createdAt: new Date(createdAt.getTime() + this.rng.int(1, 20) * MINUTE) },
      ];
      assertTeamRoster(members.map((m) => ({ userId: m.userId, role: m.role })));
      this.data.teams.push(row);
      this.data.teamMembers.push(...members);
      this.audit({
        actorKind: 'player',
        actorUserId: captain.row.id,
        action: 'team.created',
        subjectType: 'team',
        subjectId: row.id,
        detail: { tournamentId: t.id, name: row.name, invitedPhoneE164: row.invitedPhoneE164 },
        createdAt,
      });
      return { row, captain, player, strength: (captain.strength + player.strength) / 2 };
    });

    // The organizer seeds the strongest entries by hand: entry seeds 1..seeded.
    [...teams]
      .sort((x, y) => y.strength - x.strength)
      .slice(0, options.seeded)
      .forEach((team, i) => {
        team.row.seed = i + 1;
      });
    return teams;
  }

  /** The captain's entry donation, succeeded, plus the team's registration audit trail. */
  entryDonation(t: NewTournament, team: SeedTeam, status: NewDonation['status']): NewDonation {
    const createdAt = team.row.registeredAt ?? team.row.createdAt ?? this.anchor;
    const settledAt = new Date(createdAt.getTime() + this.rng.int(1, 4) * MINUTE);
    const donation: NewDonation = {
      id: this.mint('don'),
      tournamentId: t.id,
      teamId: team.row.id,
      userId: team.captain.row.id,
      amountCents: t.entryDonationCents,
      currency: SEED_CURRENCY,
      provider: 'stripe',
      providerRef: `pi_seed_${hex(this.rng.bytes(12))}`,
      status,
      createdAt,
      updatedAt: status === 'pending' ? createdAt : settledAt,
    };
    this.data.donations.push(donation);
    this.audit({
      actorKind: 'player',
      actorUserId: team.captain.row.id,
      action: 'donation.created',
      subjectType: 'donation',
      subjectId: donation.id,
      detail: { tournamentId: t.id, teamId: team.row.id, amountCents: donation.amountCents.toString(), currency: SEED_CURRENCY, provider: 'stripe' },
      createdAt,
    });
    this.audit({
      actorKind: 'player',
      actorUserId: team.captain.row.id,
      action: 'team.status_changed',
      subjectType: 'team',
      subjectId: team.row.id,
      detail: { from: 'forming', to: 'registered', reason: 'registration', donationId: donation.id, purseEntry: 'not_wired' },
      createdAt,
    });
    if (status !== 'pending') {
      this.audit({
        actorKind: 'system',
        actorUserId: null,
        action: `donation.${status}`,
        subjectType: 'donation',
        subjectId: donation.id,
        detail: { provider: 'stripe', eventId: `evt_seed_${hex(this.rng.bytes(8))}`, eventType: status === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed', from: 'pending' },
        createdAt: settledAt,
      });
    }
    return donation;
  }

  /** A supporter's donation with no team. */
  supporterDonation(t: NewTournament, user: SeedUser | null, amountCents: bigint, at: Date): NewDonation {
    const donation: NewDonation = {
      id: this.mint('don'),
      tournamentId: t.id,
      teamId: null,
      userId: user?.row.id ?? null,
      amountCents,
      currency: SEED_CURRENCY,
      provider: 'stripe',
      providerRef: `pi_seed_${hex(this.rng.bytes(12))}`,
      status: 'succeeded',
      createdAt: at,
      updatedAt: new Date(at.getTime() + this.rng.int(1, 3) * MINUTE),
    };
    this.data.donations.push(donation);
    return donation;
  }

  // ---- scoring -------------------------------------------------------------------------

  /** One legal completed set between two strengths. */
  playSet(a: SeedTeam, b: SeedTeam, target: number): { a: number; b: number; winner: Side } {
    const diff = a.strength - b.strength;
    const pA = 1 / (1 + Math.exp(-2.4 * diff));
    const winner: Side = this.rng.chance(pA) ? 'a' : 'b';
    const closeness = 1 - Math.min(1, Math.abs(diff));
    const deuce = this.rng.chance(0.08 + 0.1 * closeness);
    let loser: number;
    if (deuce) {
      loser = Math.max(target - 1, target + this.rng.int(-1, 3));
    } else {
      const spread = target === DECIDING_SET_TARGET ? 4 : 6;
      const mean = target - 2 - spread + spread * closeness;
      const sample = mean + (this.rng.next() + this.rng.next() - 1) * spread;
      loser = Math.min(target - 2, Math.max(Math.round(target * 0.35), Math.round(sample)));
    }
    const win = loser >= target - 1 ? loser + 2 : target;
    const verdict = judgeSet(winner === 'a' ? win : loser, winner === 'a' ? loser : win, target);
    if (!verdict.legal) throw new Error(`seed: generated an illegal set ${win}–${loser} to ${target}: ${verdict.reason}`);
    return winner === 'a' ? { a: win, b: loser, winner } : { a: loser, b: win, winner };
  }

  /** A complete, legal match. */
  playMatch(a: SeedTeam, b: SeedTeam, bestOf: BestOf): { sets: SetScore[]; winner: Side } {
    const sets: SetScore[] = [];
    const won = { a: 0, b: 0 };
    const needed = bestOf === 3 ? 2 : 1;
    let n = 1;
    while (won.a < needed && won.b < needed) {
      const s = this.playSet(a, b, setTarget(n, bestOf));
      sets.push({ setNumber: n, teamAPoints: s.a, teamBPoints: s.b });
      won[s.winner] += 1;
      n += 1;
    }
    const verdict = judgeMatch(sets, bestOf);
    if (!verdict.legal) throw new Error(`seed: generated an illegal match: ${verdict.reason}`);
    return { sets, winner: verdict.winner };
  }

  /** Record a played result: agreed set rows, the winner, and the system's finalisation audit. */
  finalise(match: NewMatch, a: SeedTeam, b: SeedTeam, result: { sets: SetScore[]; winner: Side }, finalizedAt: Date): void {
    match.status = 'final';
    match.winnerTeamId = result.winner === 'a' ? a.row.id : b.row.id;
    match.finalizedAt = finalizedAt;
    match.updatedAt = finalizedAt;
    for (const s of result.sets) {
      this.data.sets.push({
        id: this.mint('set'),
        matchId: match.id,
        setNumber: s.setNumber,
        teamAPoints: s.teamAPoints,
        teamBPoints: s.teamBPoints,
        agreed: true,
        createdAt: finalizedAt,
      });
    }
    this.audit({
      actorKind: 'system',
      actorUserId: null,
      action: 'match.finalized',
      subjectType: 'match',
      subjectId: match.id,
      detail: { winnerTeamId: match.winnerTeamId, sets: result.sets },
      createdAt: finalizedAt,
    });
  }

  // ---- pool stage ----------------------------------------------------------------------

  /** Draw and fully play the pools with the engine; returns the persisted config and the standings input. */
  poolStage(
    t: NewTournament,
    teams: readonly SeedTeam[],
    organizer: SeedUser,
    options: { poolSize: number; courts: number; advancement: PoolToBracketConfig['advancement']; drawnAt: Date; rngSeed: number },
  ): { config: PoolToBracketConfig; pools: Array<{ row: NewPool; teams: SeedTeam[] }>; played: Map<string, StandingsMatch[]> } {
    const config: PoolToBracketConfig = {
      version: DRAW_CONFIG_VERSION,
      format: 'pool_to_bracket',
      courts: options.courts,
      poolSize: options.poolSize,
      advancement: options.advancement,
      rngSeed: options.rngSeed,
      bestOf: { pool: 1, bracket: 3 },
    };
    const field: DrawTeam[] = teams.map((team) => ({ id: team.row.id, seed: team.row.seed ?? null }));
    const draw = drawPools({ teams: field, poolSize: config.poolSize, courts: config.courts, bestOf: config.bestOf.pool, rng: createRng(config.rngSeed) });
    const byId = new Map(teams.map((team) => [team.row.id, team]));
    const startsAt = t.startsAt;

    const pools = draw.pools.map((pool) => {
      const row: NewPool = { id: this.mint('pol'), tournamentId: t.id, label: pool.label, sequence: pool.sequence, courtLabel: pool.courtLabel, createdAt: options.drawnAt };
      this.data.pools.push(row);
      pool.teamIds.forEach((teamId, index) => {
        this.data.poolTeams.push({ id: this.mint('plt'), poolId: row.id, teamId, position: index + 1, createdAt: options.drawnAt });
      });
      return { row, teams: pool.teamIds.map((id) => byId.get(id)).filter((x): x is SeedTeam => x !== undefined) };
    });

    const played = new Map<string, StandingsMatch[]>();
    for (const m of draw.matches) {
      const pool = pools[m.poolSequence];
      const a = byId.get(m.teamAId);
      const b = byId.get(m.teamBId);
      if (pool === undefined || a === undefined || b === undefined) throw new Error('seed: pool match references an unknown team');
      const scheduledAt = new Date(startsAt.getTime() + m.courtSlot * POOL_MATCH_MINUTES * MINUTE);
      const startedAt = new Date(scheduledAt.getTime() + this.rng.int(1, 5) * MINUTE);
      const finalizedAt = new Date(startedAt.getTime() + this.rng.int(18, 26) * MINUTE);
      const match: NewMatch = {
        id: this.mint('mch'),
        tournamentId: t.id,
        poolId: pool.row.id,
        round: m.round,
        bracketPosition: null,
        courtLabel: m.courtLabel,
        teamAId: a.row.id,
        teamBId: b.row.id,
        teamASeed: null,
        teamBSeed: null,
        bestOf: m.bestOf,
        status: 'scheduled',
        winnerTeamId: null,
        nextMatchId: null,
        nextMatchSlot: null,
        scheduledAt,
        startedAt,
        finalizedAt: null,
        createdAt: options.drawnAt,
        updatedAt: options.drawnAt,
      };
      const result = this.playMatch(a, b, m.bestOf);
      this.finalise(match, a, b, result, finalizedAt);
      this.data.matches.push(match);
      const list = played.get(pool.row.id) ?? [];
      list.push({ teamAId: a.row.id, teamBId: b.row.id, winnerTeamId: match.winnerTeamId ?? a.row.id, sets: result.sets });
      played.set(pool.row.id, list);
    }

    this.audit({
      actorKind: 'organizer',
      actorUserId: organizer.row.id,
      action: 'tournament.drawn',
      subjectType: 'tournament',
      subjectId: t.id,
      detail: { stage: 'pools', config, pools: pools.length, matches: draw.matches.length, replaced: false },
      createdAt: options.drawnAt,
    });
    t.drawConfig = config;
    return { config, pools, played };
  }

  // ---- bracket -------------------------------------------------------------------------

  /**
   * Draw the bracket from the pool standings with the engine and play it according to
   * `plan`: a status per bracket position; anything unplanned stays `scheduled`.
   */
  bracketStage(
    t: NewTournament,
    stage: ReturnType<SeedBuilder['poolStage']>,
    teams: readonly SeedTeam[],
    organizer: SeedUser,
    options: { drawnAt: Date; plan: Partial<Record<number, MatchStatus>> },
  ): BracketDraw {
    const standings = stage.pools.map((pool) => ({
      sequence: pool.row.sequence,
      standings: computeStandings(
        pool.teams.map((team) => team.row.id),
        stage.played.get(pool.row.id) ?? [],
      ),
    }));
    const seeds = rankForBracket(standings, stage.config.advancement);
    const draw = drawBracket({ seeds, courts: stage.config.courts, bestOf: stage.config.bestOf.bracket });
    const byId = new Map(teams.map((team) => [team.row.id, team]));

    const lastPoolSlot = Math.max(...this.data.matches.filter((m) => m.tournamentId === t.id && m.poolId !== null).map((m) => m.scheduledAt?.getTime() ?? 0));
    const bracketStart = new Date(lastPoolSlot + (POOL_MATCH_MINUTES + STAGE_BREAK_MINUTES) * MINUTE);

    const rows = new Map<number, NewMatch>();
    for (const m of draw.matches) {
      const isBye = m.isBye;
      rows.set(m.position, {
        id: this.mint('mch'),
        tournamentId: t.id,
        poolId: null,
        round: m.round,
        bracketPosition: m.position,
        courtLabel: isBye ? null : m.courtLabel,
        teamAId: m.teamAId,
        teamBId: m.teamBId,
        teamASeed: m.teamASeed,
        teamBSeed: m.teamBSeed,
        bestOf: m.bestOf,
        status: isBye ? 'bye' : 'scheduled',
        winnerTeamId: isBye ? m.teamAId : null,
        nextMatchId: null,
        nextMatchSlot: m.nextSlot,
        scheduledAt: isBye ? null : new Date(bracketStart.getTime() + m.courtSlot * BRACKET_MATCH_MINUTES * MINUTE),
        startedAt: null,
        finalizedAt: isBye ? options.drawnAt : null,
        createdAt: options.drawnAt,
        updatedAt: options.drawnAt,
      });
    }
    for (const m of draw.matches) {
      const row = rows.get(m.position);
      if (row !== undefined && m.nextPosition !== null) row.nextMatchId = rows.get(m.nextPosition)?.id ?? null;
    }
    for (const row of rows.values()) {
      if (row.status === 'bye') {
        this.audit({
          actorKind: 'system',
          actorUserId: null,
          action: 'match.bye',
          subjectType: 'match',
          subjectId: row.id,
          detail: { teamId: row.teamAId, seed: row.teamASeed, advancedTo: row.nextMatchId },
          createdAt: options.drawnAt,
        });
      }
    }
    this.audit({
      actorKind: 'organizer',
      actorUserId: organizer.row.id,
      action: 'tournament.drawn',
      subjectType: 'tournament',
      subjectId: t.id,
      detail: { stage: 'bracket', config: stage.config, size: draw.size, rounds: draw.rounds, byes: draw.matches.filter((m) => m.isBye).length, seeds, replaced: false },
      createdAt: options.drawnAt,
    });

    // Play in position order so a round is complete before the next one is populated.
    const ordered = [...rows.values()].sort((x, y) => (x.bracketPosition ?? 0) - (y.bracketPosition ?? 0));
    for (const row of ordered) {
      const position = row.bracketPosition ?? null;
      if (row.status === 'bye' || position === null) continue;
      const desired = options.plan[position] ?? 'scheduled';
      if (desired === 'scheduled') continue;
      const teamAId = row.teamAId ?? null;
      const teamBId = row.teamBId ?? null;
      const a = teamAId === null ? undefined : byId.get(teamAId);
      const b = teamBId === null ? undefined : byId.get(teamBId);
      if (a === undefined || b === undefined) throw new Error(`seed: bracket position ${position} planned as ${desired} but lacks two teams`);
      const scheduledAt = row.scheduledAt ?? bracketStart;
      const startedAt = new Date(scheduledAt.getTime() + this.rng.int(2, 8) * MINUTE);
      row.startedAt = startedAt;
      if (desired === 'in_progress') {
        row.status = 'in_progress';
        row.updatedAt = startedAt;
        continue;
      }
      if (desired === 'awaiting_scores') {
        row.status = 'awaiting_scores';
        row.updatedAt = new Date(startedAt.getTime() + 41 * MINUTE);
        continue;
      }
      if (desired !== 'final') throw new Error(`seed: bracket plan status ${desired} is not supported`);
      const result = this.playMatch(a, b, 3);
      const finalizedAt = new Date(startedAt.getTime() + (30 + 12 * (result.sets.length - 2)) * MINUTE + this.rng.int(0, 6) * MINUTE);
      this.finalise(row, a, b, result, finalizedAt);
      const winnerId = row.winnerTeamId ?? a.row.id;
      const advancement = advanceWinner(
        {
          id: row.id,
          teamAId: row.teamAId ?? null,
          teamBId: row.teamBId ?? null,
          teamASeed: row.teamASeed ?? null,
          teamBSeed: row.teamBSeed ?? null,
          nextMatchId: row.nextMatchId ?? null,
          nextMatchSlot: row.nextMatchSlot ?? null,
        },
        winnerId,
      );
      if (advancement !== null) {
        const next = [...rows.values()].find((r) => r.id === advancement.nextMatchId);
        if (next === undefined) throw new Error('seed: advancement to an unknown match');
        if (advancement.slot === 'a') {
          next.teamAId = winnerId;
          next.teamASeed = advancement.seed;
        } else {
          next.teamBId = winnerId;
          next.teamBSeed = advancement.seed;
        }
      }
    }
    this.data.matches.push(...ordered);
    return draw;
  }
}

// ---- The dataset ---------------------------------------------------------------------------

export function buildSeed(options: SeedOptions): SeedDataset {
  const b = new SeedBuilder(options.anchor, options.rngSeed ?? SEED_RNG_SEED);
  const charity = b.buildCharity();
  const { organizers, players } = b.buildUsers();
  const organizer = organizers[0];
  if (organizer === undefined || charity.id === undefined) throw new Error('seed: organizer or charity missing');

  // ---- Settled: Low Tide Open, four weeks ago. 16 teams, 4 pools, bracket of 8, all final.
  {
    const start = b.at(-28 * DAY);
    const created = b.at(-75 * DAY);
    const t = b.tournament(
      {
        slug: SEED_SLUGS.settled,
        name: 'Low Tide Open',
        subtitle: 'Season opener on the south courts',
        beneficiaryId: charity.id,
        venueName: 'South Mission Beach Courts',
        venueCity: 'San Diego',
        venueRegion: 'CA',
        startsAt: start,
        endsAt: new Date(start.getTime() + 8 * HOUR),
        format: 'pool_to_bracket',
        division: 'open',
        maxTeams: 16,
        entryDonationCents: 4000n,
        fundraisingGoalCents: 200_000n,
        status: 'settled',
        drawConfig: null,
        createdAt: created,
      },
      organizer,
    );
    const roster = b.rng.shuffle(players).slice(0, 32);
    const pairs = Array.from({ length: 16 }, (_, i) => [roster[i * 2], roster[i * 2 + 1]] as const).filter(
      (pair): pair is readonly [SeedUser, SeedUser] => pair[0] !== undefined && pair[1] !== undefined,
    );
    const teams = b.buildTeams(t, pairs, { status: 'registered', registeredFrom: b.at(-70 * DAY), registeredTo: b.at(-32 * DAY), seeded: 4 });
    for (const team of teams) b.entryDonation(t, team, 'succeeded');
    b.supporterDonation(t, null, 50_000n, b.at(-40 * DAY));
    b.supporterDonation(t, players[40] ?? null, 25_000n, b.at(-35 * DAY));
    b.supporterDonation(t, null, 85_000n, b.at(-29 * DAY));
    b.supporterDonation(t, players[41] ?? null, 10_000n, b.at(-27 * DAY));
    b.transitions(t, organizer, [
      ['draft', 'registration_open', b.at(-72 * DAY), 'organizer'],
      ['registration_open', 'registration_closed', b.at(-30 * DAY), 'organizer'],
    ]);
    const stage = b.poolStage(t, teams, organizer, {
      poolSize: 4,
      courts: 4,
      advancement: { perPool: 2, wildcards: 0 },
      drawnAt: b.at(-29 * DAY),
      rngSeed: 0x1a2b,
    });
    b.transitions(t, organizer, [['registration_closed', 'live', new Date(start.getTime() - 30 * MINUTE), 'organizer']]);
    b.bracketStage(t, stage, teams, organizer, {
      drawnAt: new Date(start.getTime() + 4 * HOUR),
      plan: { 1: 'final', 2: 'final', 3: 'final', 4: 'final', 5: 'final', 6: 'final', 7: 'final' },
    });
    b.transitions(t, organizer, [
      ['live', 'awaiting_settlement', new Date(start.getTime() + 7 * HOUR + 40 * MINUTE), 'organizer'],
      ['awaiting_settlement', 'settled', new Date(start.getTime() + 8 * HOUR), 'system'],
    ]);
  }

  // ---- Live: Sandbar Classic, today. 24 teams, 6 pools of 4 (complete), 16-bracket with one bye,
  // quarterfinals in progress: one final, one in progress, one awaiting scores, one scheduled.
  {
    const start = options.anchor;
    const created = b.at(-45 * DAY);
    const t = b.tournament(
      {
        slug: SEED_SLUGS.live,
        name: 'Sandbar Classic',
        subtitle: 'The flagship: 24 teams, six pools, one bracket',
        beneficiaryId: charity.id,
        venueName: 'Sandbar Courts',
        venueCity: 'Santa Cruz',
        venueRegion: 'CA',
        startsAt: start,
        endsAt: new Date(start.getTime() + 9 * HOUR),
        format: 'pool_to_bracket',
        division: 'open',
        maxTeams: 24,
        entryDonationCents: 5000n,
        fundraisingGoalCents: 500_000n,
        status: 'live',
        drawConfig: null,
        createdAt: created,
      },
      organizer,
    );
    const pairs = Array.from({ length: 24 }, (_, i) => [players[i * 2], players[i * 2 + 1]] as const).filter(
      (pair): pair is readonly [SeedUser, SeedUser] => pair[0] !== undefined && pair[1] !== undefined,
    );
    const teams = b.buildTeams(t, pairs, { status: 'checked_in', registeredFrom: b.at(-40 * DAY), registeredTo: b.at(-3 * DAY), seeded: 8 });
    for (const team of teams) b.entryDonation(t, team, 'succeeded');
    b.supporterDonation(t, null, 100_000n, b.at(-20 * DAY));
    b.supporterDonation(t, organizers[1] ?? null, 15_000n, b.at(-12 * DAY));
    b.supporterDonation(t, null, 42_500n, b.at(-2 * DAY));
    b.supporterDonation(t, null, 7_500n, new Date(start.getTime() + 2 * HOUR));
    b.transitions(t, organizer, [
      ['draft', 'registration_open', b.at(-42 * DAY), 'organizer'],
      ['registration_open', 'registration_closed', b.at(-2 * DAY), 'organizer'],
    ]);
    const stage = b.poolStage(t, teams, organizer, {
      poolSize: 4,
      courts: 6,
      advancement: { perPool: 2, wildcards: 3 },
      drawnAt: b.at(-1 * DAY),
      rngSeed: 0x5a1b,
    });
    b.transitions(t, organizer, [['registration_closed', 'live', new Date(start.getTime() - 45 * MINUTE), 'organizer']]);
    b.bracketStage(t, stage, teams, organizer, {
      drawnAt: new Date(start.getTime() + 3 * HOUR + 40 * MINUTE),
      plan: { 1: 'final', 2: 'final', 3: 'final', 4: 'final', 5: 'final', 6: 'final', 7: 'final', 8: 'final', 9: 'final', 10: 'in_progress', 11: 'awaiting_scores' },
    });
    for (const sponsor of [
      { name: 'Driftline Boardshop', tier: 'presenting' as const, cents: 150_000n },
      { name: 'Cove Coffee Roasters', tier: 'court' as const, cents: 40_000n },
      { name: 'Northshore Optics', tier: 'prize' as const, cents: 60_000n },
    ]) {
      b.data.sponsors.push({
        id: b.mint('spn'),
        tournamentId: t.id,
        name: sponsor.name,
        logoUrl: null,
        tier: sponsor.tier,
        prizeContributionCents: sponsor.cents,
        createdAt: created,
        updatedAt: created,
      });
    }
  }

  // ---- Upcoming: Pier 9 Open, in two weeks. Registration open: 10 registered teams, one team
  // whose payment is pending, one forming team with a failed payment, one still waiting on its partner.
  {
    const start = b.at(14 * DAY);
    const created = b.at(-20 * DAY);
    const t = b.tournament(
      {
        slug: SEED_SLUGS.upcoming,
        name: 'Pier 9 Open',
        subtitle: 'Coed fours, sunset finals',
        beneficiaryId: charity.id,
        venueName: 'Pier 9 Beach',
        venueCity: 'Huntington Beach',
        venueRegion: 'CA',
        startsAt: start,
        endsAt: new Date(start.getTime() + 8 * HOUR),
        format: 'pool_to_bracket',
        division: 'coed',
        maxTeams: 16,
        entryDonationCents: 4000n,
        fundraisingGoalCents: 300_000n,
        status: 'registration_open',
        drawConfig: null,
        createdAt: created,
      },
      organizer,
    );
    const roster = b.rng.shuffle(players).slice(0, 26);
    const pair = (i: number): readonly [SeedUser, SeedUser] => {
      const captain = roster[i * 2];
      const player = roster[i * 2 + 1];
      if (captain === undefined || player === undefined) throw new Error('seed: roster too small');
      return [captain, player];
    };
    const registered = b.buildTeams(
      t,
      Array.from({ length: 10 }, (_, i) => pair(i)),
      { status: 'registered', registeredFrom: b.at(-18 * DAY), registeredTo: b.at(-1 * DAY), seeded: 0 },
    );
    for (const team of registered) b.entryDonation(t, team, 'succeeded');
    // A checkout never finished: the reservation lapsed days ago, so the team holds no place
    // until the captain registers again or the old payment lands (server/field.ts).
    const [pendingTeam] = b.buildTeams(t, [pair(10)], { status: 'registered', registeredFrom: b.at(-4 * DAY), registeredTo: b.at(-4 * DAY + HOUR), seeded: 0 });
    if (pendingTeam !== undefined) b.entryDonation(t, pendingTeam, 'pending');
    const [failedTeam] = b.buildTeams(t, [pair(11)], { status: 'forming', registeredFrom: b.at(-3 * DAY), registeredTo: b.at(-2 * DAY), seeded: 0 });
    if (failedTeam !== undefined) {
      failedTeam.row.registeredAt = null;
      b.entryDonation(t, failedTeam, 'failed');
      b.audit({
        actorKind: 'system',
        actorUserId: null,
        action: 'team.status_changed',
        subjectType: 'team',
        subjectId: failedTeam.row.id,
        detail: { from: 'registered', to: 'forming', reason: 'donation_failed' },
        createdAt: b.at(-2 * DAY),
      });
    }
    // A captain still waiting on their partner: one member, an invite, no donation.
    const waitingCaptain = pair(12)[0];
    const waitingPartner = pair(12)[1];
    const waitingCreated = b.at(-6 * HOUR);
    const waiting: NewTeam = {
      id: b.mint('tm'),
      tournamentId: t.id,
      name: `${waitingCaptain.row.displayName.split(' ').slice(-1)[0] ?? 'Team'} / ?`,
      seed: null,
      status: 'forming',
      invitedPhoneE164: waitingPartner.row.phoneE164 ?? null,
      registeredAt: null,
      createdAt: waitingCreated,
      updatedAt: waitingCreated,
    };
    b.data.teams.push(waiting);
    b.data.teamMembers.push({ id: b.mint('tmm'), teamId: waiting.id, userId: waitingCaptain.row.id, role: 'captain', createdAt: waitingCreated });
    b.supporterDonation(t, null, 20_000n, b.at(-5 * DAY));
    b.transitions(t, organizer, [['draft', 'registration_open', b.at(-19 * DAY), 'organizer']]);
  }

  return b.data;
}
