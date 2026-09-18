import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as devLogin } from '../src/app/api/dev/login/route.dev';
import { GET as getMatch } from '../src/app/api/matches/[id]/route';
import { GET as getMe } from '../src/app/api/me/route';
import { GET as getImpact } from '../src/app/api/tournaments/[slug]/impact/route';
import { GET as getTournament } from '../src/app/api/tournaments/[slug]/route';
import { GET as getStandings } from '../src/app/api/tournaments/[slug]/standings/route';
import { GET as listTournaments } from '../src/app/api/tournaments/route';
import { donations, matches, sets, sponsors, teamMembers, teams, tournaments } from '../src/db/schema';
import { buildSeed, SEED_ORGANIZER_PHONE, SEED_PHONE_PREFIX, SEED_SLUGS, writeSeed, type SeedDataset } from '../src/db/seed';
import { drawBracket, rankForBracket } from '../src/domain/draw';
import { drawConfigSchema } from '../src/domain/draw-config';
import { createRng } from '../src/domain/rng';
import { judgeMatch, type SetScore } from '../src/domain/scoreline';
import { checkTeamRoster } from '../src/domain/team';
import type { PublicTournament, PublicTournamentDetail } from '../src/server/public-shape';
import { loadPoolStage, standingsForStage } from '../src/server/standings';
import { data, expectNoPurseKeys, params, request, testDatabase, truncateAll, type Database } from './helpers';

const ANCHOR = new Date('2026-09-19T16:00:00.000Z');

describe('seed dataset', () => {
  let database: Database;
  let dataset: SeedDataset;

  beforeAll(async () => {
    database = testDatabase();
    await truncateAll(database);
    dataset = buildSeed({ anchor: ANCHOR });
    await writeSeed(database.db, dataset);
  });
  afterAll(async () => {
    await truncateAll(database);
    await database.close();
  });

  it('is deterministic and keeps its ids across anchors', () => {
    const again = buildSeed({ anchor: ANCHOR });
    expect(JSON.stringify(again, bigintSafe)).toBe(JSON.stringify(dataset, bigintSafe));
    const moved = buildSeed({ anchor: new Date('2027-01-09T16:00:00.000Z') });
    expect(moved.tournaments.map((t) => t.id)).toEqual(dataset.tournaments.map((t) => t.id));
    expect(moved.matches.map((m) => m.id)).toEqual(dataset.matches.map((m) => m.id));
    expect(moved.tournaments[0]?.startsAt).not.toEqual(dataset.tournaments[0]?.startsAt);
  });

  it('writes idempotently: a second run changes no counts and restores a hand edit', async () => {
    const before = await database.db.select().from(matches);
    const target = before[0];
    if (target === undefined) throw new Error('no matches seeded');
    await database.db.update(matches).set({ courtLabel: 'Court 99' }).where(eq(matches.id, target.id));
    const summary = await writeSeed(database.db, dataset);
    expect(summary.matches).toBe(before.length);
    expect(await database.db.select().from(matches)).toHaveLength(before.length);
    expect((await database.db.select().from(matches).where(eq(matches.id, target.id)))[0]?.courtLabel).toBe(target.courtLabel);
    expect(await database.db.select().from(teams)).toHaveLength(dataset.teams.length);
  });

  it('seeds one tournament per required status, a charity, organizers, players and three sponsors', async () => {
    const rows = await database.db.select().from(tournaments);
    expect(rows.map((t) => [t.slug, t.status]).sort()).toEqual([
      [SEED_SLUGS.settled, 'settled'],
      [SEED_SLUGS.upcoming, 'registration_open'],
      [SEED_SLUGS.live, 'live'],
    ].sort());
    expect(rows.every((t) => t.purseContestId === null && t.purseExternalId.startsWith('sideout-contest-'))).toBe(true);
    expect(dataset.charities).toHaveLength(1);
    expect(dataset.users.filter((u) => u.role === 'organizer')).toHaveLength(2);
    expect(dataset.users.filter((u) => u.role === 'player')).toHaveLength(48);
    expect(dataset.users.every((u) => u.phoneE164?.startsWith(SEED_PHONE_PREFIX))).toBe(true);
    expect(new Set(dataset.users.map((u) => u.phoneE164)).size).toBe(dataset.users.length);
    expect(new Set(dataset.users.map((u) => u.purseExternalId)).size).toBe(dataset.users.length);
    const sponsorRows = await database.db.select().from(sponsors);
    expect(sponsorRows.map((s) => s.tier).sort()).toEqual(['court', 'presenting', 'prize']);
  });

  it('every counted team has exactly two members with one captain', async () => {
    const teamRows = await database.db.select().from(teams);
    const memberRows = await database.db.select().from(teamMembers);
    for (const team of teamRows) {
      const roster = memberRows.filter((m) => m.teamId === team.id).map((m) => ({ userId: m.userId, role: m.role }));
      if (team.status === 'forming' && roster.length === 1) continue; // the captain still waiting on a partner
      expect(checkTeamRoster(roster)).toEqual({ ok: true });
    }
    // Nobody is on two live teams in one tournament.
    for (const t of await database.db.select().from(tournaments)) {
      const live = teamRows.filter((team) => team.tournamentId === t.id && team.status !== 'withdrawn').map((team) => team.id);
      const users = memberRows.filter((m) => live.includes(m.teamId)).map((m) => m.userId);
      expect(new Set(users).size).toBe(users.length);
    }
  });

  it('every set is legal and every winner follows from its sets', async () => {
    const matchRows = await database.db.select().from(matches);
    const setRows = await database.db.select().from(sets);
    expect(matchRows.filter((m) => m.status === 'final').length).toBeGreaterThan(50);
    for (const m of matchRows) {
      const scores: SetScore[] = setRows
        .filter((s) => s.matchId === m.id)
        .sort((x, y) => x.setNumber - y.setNumber)
        .map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints }));
      if (m.status === 'final') {
        const verdict = judgeMatch(scores, m.bestOf as 1 | 3);
        expect(verdict.legal).toBe(true);
        if (!verdict.legal) continue;
        expect(m.winnerTeamId).toBe(verdict.winner === 'a' ? m.teamAId : m.teamBId);
        expect(setRows.filter((s) => s.matchId === m.id).every((s) => s.agreed)).toBe(true);
      } else if (m.status === 'bye') {
        expect(scores).toEqual([]);
        expect(m).toMatchObject({ round: 1, teamBId: null, winnerTeamId: m.teamAId });
      } else {
        expect(scores).toEqual([]);
        expect(m.winnerTeamId).toBeNull();
      }
    }
  });

  it('the live bracket is what the engine derives from the seeded pool results', async () => {
    const [live] = await database.db.select().from(tournaments).where(eq(tournaments.slug, SEED_SLUGS.live));
    if (live === undefined) throw new Error('live tournament missing');
    const config = drawConfigSchema.parse(live.drawConfig);
    if (config.format !== 'pool_to_bracket') throw new Error('unexpected format');
    expect(config).toMatchObject({ poolSize: 4, courts: 6, advancement: { perPool: 2, wildcards: 3 } });

    const stage = await loadPoolStage(database.db, live.id);
    expect(stage.pools).toHaveLength(6);
    const poolMatches = stage.matches.filter((m) => m.poolId !== null);
    expect(poolMatches).toHaveLength(36);
    expect(poolMatches.every((m) => m.status === 'final')).toBe(true);

    const standings = standingsForStage(stage);
    const { seeds } = rankForBracket(standings, config.advancement, createRng(config.rngSeed));
    const expected = drawBracket({ seeds, courts: config.courts, bestOf: config.bestOf.bracket });
    const bracket = stage.matches.filter((m) => m.bracketPosition !== null).sort((x, y) => (x.bracketPosition ?? 0) - (y.bracketPosition ?? 0));
    expect(bracket).toHaveLength(15);
    for (const m of expected.matches.filter((x) => x.round === 1)) {
      const row = bracket.find((r) => r.bracketPosition === m.position);
      expect(row).toMatchObject({ teamAId: m.teamAId, teamBId: m.teamBId, teamASeed: m.teamASeed, teamBSeed: m.teamBSeed, status: m.isBye ? 'bye' : 'final' });
    }
    const quarterfinals = bracket.filter((m) => m.round === 2).map((m) => m.status);
    expect(quarterfinals.sort()).toEqual(['awaiting_scores', 'final', 'in_progress', 'scheduled']);
    expect(bracket.filter((m) => m.status === 'bye')).toHaveLength(1);
    // Every decided match's winner sits in the slot its next link names.
    for (const m of bracket.filter((r) => r.winnerTeamId !== null && r.nextMatchId !== null)) {
      const next = bracket.find((r) => r.id === m.nextMatchId);
      expect(m.nextMatchSlot === 'a' ? next?.teamAId : next?.teamBId).toBe(m.winnerTeamId);
    }
    // The settled event is complete.
    const [settled] = await database.db.select().from(tournaments).where(eq(tournaments.slug, SEED_SLUGS.settled));
    const settledMatches = await database.db.select().from(matches).where(eq(matches.tournamentId, settled?.id ?? ''));
    expect(settledMatches.every((m) => m.status === 'final' || m.status === 'bye')).toBe(true);
    expect(settledMatches.filter((m) => m.nextMatchId === null && m.bracketPosition !== null)).toHaveLength(1);
    expect(await database.db.select().from(matches).where(and(isNull(matches.poolId), isNotNull(matches.bracketPosition), eq(matches.tournamentId, settled?.id ?? '')))).toHaveLength(7);
  });

  it('impact figures equal the sum of succeeded donations, and pending or failed ones count for nothing', async () => {
    for (const slug of Object.values(SEED_SLUGS)) {
      const [t] = await database.db.select().from(tournaments).where(eq(tournaments.slug, slug));
      const rows = await database.db.select().from(donations).where(eq(donations.tournamentId, t?.id ?? ''));
      const succeeded = rows.filter((d) => d.status === 'succeeded');
      const expectedRaised = succeeded.reduce((sum, d) => sum + d.amountCents, 0n);
      const impact = await data<{ raisedCents: string; goalCents: string; progressPercent: number; donationCount: number }>(
        await getImpact(request('GET', '/x'), params({ slug })),
      );
      expect(impact.raisedCents).toBe(expectedRaised.toString());
      expect(impact.donationCount).toBe(succeeded.length);
      expect(impact.goalCents).toBe(t?.fundraisingGoalCents.toString());
      const goal = t?.fundraisingGoalCents ?? 1n;
      expect(BigInt(impact.progressPercent)).toBe(expectedRaised * 100n > goal * 100n ? 100n : (expectedRaised * 100n) / goal);
      expectNoPurseKeys(impact);
    }
    const upcoming = await database.db.select().from(donations).innerJoin(tournaments, eq(tournaments.id, donations.tournamentId)).where(eq(tournaments.slug, SEED_SLUGS.upcoming));
    expect(upcoming.map((r) => r.donations.status).sort()).toContain('pending');
    expect(upcoming.map((r) => r.donations.status).sort()).toContain('failed');
    const settledRaised = await data<{ progressPercent: number }>(await getImpact(request('GET', '/x'), params({ slug: SEED_SLUGS.settled })));
    expect(settledRaised.progressPercent).toBe(100);
  });

  it('serves every seeded event through the public API without a single Purse identifier', async () => {
    const list = await data<{ tournaments: PublicTournament[] }>(await listTournaments(request('GET', '/api/tournaments')));
    expect(list.tournaments.map((t) => t.slug).sort()).toEqual(Object.values(SEED_SLUGS).sort());
    expect(list.tournaments.find((t) => t.slug === SEED_SLUGS.live)?.teamCount).toBe(24);
    // Ten paid teams; the lapsed pending reservation holds no place.
    expect(list.tournaments.find((t) => t.slug === SEED_SLUGS.upcoming)?.teamCount).toBe(10);
    expectNoPurseKeys(list);
    const upcoming = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug: SEED_SLUGS.upcoming })));
    const pendingTeamIds = dataset.donations.filter((d) => d.status === 'pending').map((d) => d.teamId);
    expect(pendingTeamIds).toHaveLength(1);
    expect(upcoming.teams.map((t) => t.id)).not.toContain(pendingTeamIds[0]);
    expect(upcoming.teams).toHaveLength(10);

    for (const slug of Object.values(SEED_SLUGS)) {
      const detail = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug })));
      expectNoPurseKeys(detail);
      expect(detail.teams.every((team) => team.members.length === 2 && (team.status === 'registered' || team.status === 'checked_in'))).toBe(true);
      const standings = await data<{ pools: Array<{ standings: Array<{ rank: number }> }> }>(await getStandings(request('GET', '/x'), params({ slug })));
      expectNoPurseKeys(standings);
      for (const pool of standings.pools) expect(pool.standings[0]?.rank).toBe(1);
      for (const match of detail.bracket?.matches.slice(0, 2) ?? []) {
        const view = await getMatch(request('GET', '/x'), params({ id: match.id }));
        expect(view.status).toBe(200);
        expectNoPurseKeys(await data(view));
      }
    }
    const live = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug: SEED_SLUGS.live })));
    expect(live.sponsors.map((s) => s.tier).sort()).toEqual(['court', 'presenting', 'prize']);
    expect(live.pools).toHaveLength(6);
    expect(live.bracket).toMatchObject({ size: 16, rounds: 4 });
    expect(live.teams.filter((t) => t.seed !== null).map((t) => t.seed).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('dev login signs in a seeded organizer and their profile carries no Purse identifier', async () => {
    const response = await devLogin(request('POST', '/api/dev/login', { body: { phone: SEED_ORGANIZER_PHONE } }));
    expect(response.status).toBe(200);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    const me = await data<{ user: { role: string; phoneE164: string } }>(await getMe(request('GET', '/api/me', { cookie })));
    expect(me.user).toMatchObject({ role: 'organizer', phoneE164: SEED_ORGANIZER_PHONE });
    expectNoPurseKeys(me);
    const unknown = await devLogin(request('POST', '/api/dev/login', { body: { phone: '+14155559999' } }));
    expect(unknown.status).toBe(404);
  });
});

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
