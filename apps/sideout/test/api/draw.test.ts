import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { newId } from '@repo/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as forfeit } from '../../src/app/api/admin/matches/[id]/forfeit/route';
import { POST as draw } from '../../src/app/api/admin/tournaments/[id]/draw/route';
import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { GET as getMatch } from '../../src/app/api/matches/[id]/route';
import { GET as getTournament } from '../../src/app/api/tournaments/[slug]/route';
import { GET as getStandings } from '../../src/app/api/tournaments/[slug]/standings/route';
import { auditLog, matches, pools, poolTeams, sets, teamMembers, teams, tournaments, type Charity, type User } from '../../src/db/schema';
import { judgeMatch, type SetScore } from '../../src/domain/scoreline';
import type { StandingRow } from '../../src/domain/standings';
import { mintPurseExternalId } from '../../src/server/actor';
import type { DrawOutcome } from '../../src/server/draw';
import type { MatchView } from '../../src/server/matches';
import type { PublicTournamentDetail } from '../../src/server/public-shape';
import { cookieFor, createCharity, createUser, data, errorOf, expectNoPurseKeys, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { tournamentBody } from './tournaments.test';

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

/** What phase 7's consensus will do: agreed sets and a `final` status written by the system. */
async function finishMatch(database: Database, matchId: string, scores: SetScore[]): Promise<void> {
  const [match] = await database.db.select().from(matches).where(eq(matches.id, matchId));
  if (match?.teamAId === null || match?.teamAId === undefined || match.teamBId === null) throw new Error('match not populated');
  const verdict = judgeMatch(scores, match.bestOf as 1 | 3);
  if (!verdict.legal) throw new Error(verdict.reason);
  await database.db.insert(sets).values(scores.map((s) => ({ id: newId('set'), matchId, setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints, agreed: true })));
  await database.db
    .update(matches)
    .set({ status: 'final', winnerTeamId: verdict.winner === 'a' ? match.teamAId : match.teamBId, finalizedAt: new Date() })
    .where(eq(matches.id, matchId));
}

describe('draw, forfeit and standings', () => {
  let database: Database;
  let organizer: User;
  let charity: Charity;
  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    organizer = await createUser(database, { role: 'organizer' });
    charity = await createCharity(database);
  });
  afterAll(async () => {
    await database.close();
  });

  const cookie = () => cookieFor(organizer);
  const create = async (overrides: Record<string, unknown>) => {
    const { tournament } = await data<{ tournament: { id: string; slug: string } }>(
      await createTournament(request('POST', '/x', { body: tournamentBody(charity, overrides), cookie: cookie() })),
    );
    return tournament;
  };
  const transition = (id: string, status: string) => patchTournament(request('PATCH', '/x', { body: { status }, cookie: cookie() }), params({ id }));
  const runDraw = (id: string, body: Record<string, unknown>, preview = false) =>
    draw(request('POST', `/x${preview ? '?preview=1' : ''}`, { body, cookie: cookie() }), params({ id }));

  it('runs pool-to-bracket end to end: preview, pools, live, results, bracket, forfeit, advancement, settlement guard', async () => {
    const t = await create({ maxTeams: 16, format: 'pool_to_bracket' });
    await transition(t.id, 'registration_open');
    const teamIds = await registerTeams(database, t.id, 10, { 0: 1, 1: 2 });

    const early = await runDraw(t.id, { stage: 'pools' });
    expect(early.status).toBe(409);
    expect((await errorOf(early)).code).toBe('draw_stage_not_allowed');
    await transition(t.id, 'registration_closed');

    // Preview writes nothing.
    const preview = await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 4, courts: 3, rngSeed: 7 }, true));
    expect(preview.persisted).toBe(false);
    expect(preview.pools).toHaveLength(3);
    expect(await database.db.select().from(pools)).toEqual([]);
    expect((await database.db.select().from(tournaments).where(eq(tournaments.id, t.id)))[0]?.drawConfig).toBeNull();

    // The real draw is the same computation: same seed, same pools.
    const drawn = await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 4, courts: 3, rngSeed: 7, advancement: { perPool: 2, wildcards: 1 } }));
    expect(drawn.persisted).toBe(true);
    expect(drawn.pools.map((p) => p.teamIds)).toEqual(preview.pools.map((p) => p.teamIds));
    expect(drawn.pools.map((p) => p.teamIds.length)).toEqual([3, 3, 4]);
    expect(drawn.pools[0]?.teamIds[0]).toBe(teamIds[0]); // entry seed 1 heads pool A
    expect(drawn.pools[1]?.teamIds[0]).toBe(teamIds[1]); // entry seed 2 heads pool B
    expect(drawn.config).toMatchObject({ format: 'pool_to_bracket', poolSize: 4, courts: 3, rngSeed: 7, advancement: { perPool: 2, wildcards: 1 } });
    const poolRows = await database.db.select().from(pools).where(eq(pools.tournamentId, t.id));
    expect(poolRows.map((p) => p.label).sort()).toEqual(['Pool A', 'Pool B', 'Pool C']);
    const poolMatches = await database.db.select().from(matches).where(and(eq(matches.tournamentId, t.id), isNotNull(matches.poolId)));
    expect(poolMatches).toHaveLength(6 + 3 + 3);
    expect(poolMatches.every((m) => m.status === 'scheduled' && m.scheduledAt !== null && m.bestOf === 1)).toBe(true);
    const [saved] = await database.db.select().from(tournaments).where(eq(tournaments.id, t.id));
    expect(saved?.drawConfig).toEqual(drawn.config);

    // A redraw without a seeds list keeps the entry seeds; one with a list replaces them.
    const redrawn = await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 4, courts: 3, rngSeed: 8, advancement: { perPool: 2, wildcards: 1 } }));
    expect(redrawn.pools[0]?.teamIds[0]).toBe(teamIds[0]);
    const seedsAfter = await database.db.select({ id: teams.id, seed: teams.seed }).from(teams).where(eq(teams.tournamentId, t.id));
    expect(seedsAfter.filter((s) => s.seed !== null).map((s) => s.seed).sort()).toEqual([1, 2]);
    const reseeded = await data<DrawOutcome>(
      await runDraw(t.id, { stage: 'pools', poolSize: 4, courts: 3, rngSeed: 8, advancement: { perPool: 2, wildcards: 1 }, seeds: [{ teamId: teamIds[5] ?? '', seed: 1 }] }),
    );
    expect(reseeded.pools[0]?.teamIds[0]).toBe(teamIds[5]);
    const seedsNow = await database.db.select({ id: teams.id, seed: teams.seed }).from(teams).where(eq(teams.tournamentId, t.id));
    expect(seedsNow.filter((s) => s.seed !== null)).toEqual([{ id: teamIds[5], seed: 1 }]);
    const badSeeds = await runDraw(t.id, { stage: 'pools', seeds: [{ teamId: 'tm_00000000-0000-7000-8000-000000000000', seed: 1 }] });
    expect((await errorOf(badSeeds)).code).toBe('draw_invalid_seed_list');
    expect(await database.db.select().from(pools).where(eq(pools.tournamentId, t.id))).toHaveLength(3);

    // Bracket before live / before pool play: refused.
    const tooEarly = await runDraw(t.id, { stage: 'bracket' });
    expect((await errorOf(tooEarly)).code).toBe('draw_stage_not_allowed');
    await transition(t.id, 'live');
    const incomplete = await runDraw(t.id, { stage: 'bracket' });
    expect(incomplete.status).toBe(409);
    expect((await errorOf(incomplete)).code).toBe('pool_play_incomplete');
    const redrawLive = await runDraw(t.id, { stage: 'pools' });
    expect((await errorOf(redrawLive)).code).toBe('draw_stage_not_allowed');

    // Play the pools: team A wins every match 21–15 (phase 7 will write these through consensus).
    const toPlay = await database.db.select().from(matches).where(and(eq(matches.tournamentId, t.id), isNotNull(matches.poolId)));
    for (const m of toPlay) await finishMatch(database, m.id, [{ setNumber: 1, teamAPoints: 21, teamBPoints: 15 }]);

    const standings = await data<{ pools: Array<{ label: string; standings: StandingRow[] }> }>(await getStandings(request('GET', '/x'), params({ slug: t.slug })));
    expect(standings.pools).toHaveLength(3);
    for (const pool of standings.pools) {
      expect(pool.standings.reduce((n, r) => n + r.played, 0)).toBe(pool.standings.length * (pool.standings.length - 1));
      expect(pool.standings[0]?.rank).toBe(1);
      expect(pool.standings.every((r, i, all) => i === 0 || (all[i - 1]?.wins ?? 0) >= r.wins)).toBe(true);
    }

    const bracketPreview = await data<DrawOutcome>(await runDraw(t.id, { stage: 'bracket' }, true));
    expect(bracketPreview.persisted).toBe(false);
    expect(bracketPreview.bracket).toMatchObject({ size: 8, rounds: 3 });
    expect(bracketPreview.bracket?.seeds).toHaveLength(7); // 2 per pool + 1 wildcard
    expect(bracketPreview.matches.filter((m) => m.status === 'bye')).toHaveLength(1);
    expect(await database.db.select().from(matches).where(and(eq(matches.tournamentId, t.id), isNull(matches.poolId)))).toEqual([]);

    const bracket = await data<DrawOutcome>(await runDraw(t.id, { stage: 'bracket', courts: 12, advancement: { perPool: 3, wildcards: 0 } }));
    // The bracket stage read the persisted pools configuration (the last redraw) back, not the request's knobs.
    expect(bracket.config).toEqual(reseeded.config);
    expect(bracket.config).toMatchObject({ rngSeed: 8, courts: 3, advancement: { perPool: 2, wildcards: 1 } });
    expect(bracket.bracket?.seeds).toEqual(bracketPreview.bracket?.seeds);
    const bracketRows = await database.db.select().from(matches).where(and(eq(matches.tournamentId, t.id), isNull(matches.poolId)));
    expect(bracketRows).toHaveLength(7);
    const bye = bracketRows.find((m) => m.status === 'bye');
    expect(bye).toMatchObject({ round: 1, teamBId: null, winnerTeamId: bye?.teamAId, teamASeed: 1 });
    const nextOfBye = bracketRows.find((m) => m.id === bye?.nextMatchId);
    expect(bye?.nextMatchSlot === 'a' ? nextOfBye?.teamAId : nextOfBye?.teamBId).toBe(bye?.teamAId);
    expect(bracketRows.filter((m) => m.round === 1 && m.status === 'scheduled').every((m) => m.teamAId !== null && m.teamBId !== null && m.bestOf === 3)).toBe(true);
    expect(bracketRows.filter((m) => m.nextMatchId === null)).toHaveLength(1);

    // Pool standings are unaffected by the bracket; the detail carries everything.
    const detail = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug: t.slug })));
    expect(detail.bracket).toMatchObject({ size: 8, rounds: 3 });
    expect(detail.bracket?.matches).toHaveLength(7);
    expect(detail.pools.map((p) => p.matches.length)).toEqual([3, 3, 6]);
    expectNoPurseKeys(detail);

    // Forfeit a round-1 match: the opponent wins and lands in the linked slot with their seed.
    const played = bracketRows.find((m) => m.round === 1 && m.status === 'scheduled');
    if (played?.teamAId === null || played?.teamAId === undefined || played.teamBId === null) throw new Error('no playable round-1 match');
    const notPlaying = await forfeit(request('POST', '/x', { body: { forfeitingTeamId: teamIds[9] }, cookie: cookie() }), params({ id: played.id }));
    expect(notPlaying.status).toBe(400);
    expect((await errorOf(notPlaying)).code).toBe('not_a_participant');
    const forfeited = await data<{ match: { status: string; winnerTeamId: string }; winnerTeamId: string; advancedTo: { matchId: string; slot: 'a' | 'b' } | null }>(
      await forfeit(request('POST', '/x', { body: { forfeitingTeamId: played.teamAId }, cookie: cookie() }), params({ id: played.id })),
    );
    expect(forfeited.match.status).toBe('forfeited');
    expect(forfeited.winnerTeamId).toBe(played.teamBId);
    expect(forfeited.advancedTo).toEqual({ matchId: played.nextMatchId, slot: played.nextMatchSlot });
    const [next] = await database.db.select().from(matches).where(eq(matches.id, played.nextMatchId ?? ''));
    expect(played.nextMatchSlot === 'a' ? next?.teamAId : next?.teamBId).toBe(played.teamBId);
    expect(played.nextMatchSlot === 'a' ? next?.teamASeed : next?.teamBSeed).toBe(played.teamBSeed);
    const twice = await forfeit(request('POST', '/x', { body: { forfeitingTeamId: played.teamAId }, cookie: cookie() }), params({ id: played.id }));
    expect((await errorOf(twice)).code).toBe('transition_same_state');
    const unpopulated = (await database.db.select().from(matches).where(and(eq(matches.tournamentId, t.id), isNull(matches.poolId), eq(matches.round, 2)))).find(
      (m) => m.teamAId === null || m.teamBId === null,
    );
    const stranger = await forfeit(request('POST', '/x', { body: { forfeitingTeamId: teamIds[9] }, cookie: cookie() }), params({ id: unpopulated?.id ?? '' }));
    expect(stranger.status).toBe(409);
    expect((await errorOf(stranger)).code).toBe('match_not_populated');
    const forfeitTrail = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, played.id));
    expect(forfeitTrail.map((a) => a.action)).toEqual(['match.forfeited']);
    expect(forfeitTrail[0]?.detail).toMatchObject({ forfeitingTeamId: played.teamAId, winnerTeamId: played.teamBId, advancedTo: forfeited.advancedTo });

    const view = await data<MatchView>(await getMatch(request('GET', '/x'), params({ id: played.id })));
    expect(view.match.status).toBe('forfeited');
    expect(view.teamB?.id).toBe(played.teamBId);
    expect(view.nextMatch?.id).toBe(played.nextMatchId);
    expectNoPurseKeys(view);

    // Nothing may be redrawn once a bracket match has been decided; settlement waits for every match.
    const redrawBracket = await runDraw(t.id, { stage: 'bracket' });
    expect((await errorOf(redrawBracket)).code).toBe('bracket_in_play');
    const settle = await transition(t.id, 'awaiting_settlement');
    expect(settle.status).toBe(409);
    const settleError = await errorOf(settle);
    expect(settleError.code).toBe('matches_unresolved');
    expect((settleError.detail as { matches: unknown[] }).matches.length).toBeGreaterThan(0);

    // Finish everything and settle.
    for (let round = 1; round <= 3; round += 1) {
      const open = await database.db.select().from(matches).where(and(eq(matches.tournamentId, t.id), isNull(matches.poolId), eq(matches.round, round), eq(matches.status, 'scheduled')));
      for (const m of open) {
        await finishMatch(database, m.id, [
          { setNumber: 1, teamAPoints: 21, teamBPoints: 17 },
          { setNumber: 2, teamAPoints: 21, teamBPoints: 19 },
        ]);
        const [done] = await database.db.select().from(matches).where(eq(matches.id, m.id));
        if (done?.nextMatchId !== null && done?.nextMatchId !== undefined && done.winnerTeamId !== null) {
          await database.db
            .update(matches)
            .set(done.nextMatchSlot === 'a' ? { teamAId: done.winnerTeamId } : { teamBId: done.winnerTeamId })
            .where(eq(matches.id, done.nextMatchId));
        }
      }
    }
    const awaiting = await data<{ transition: { to: string } }>(await transition(t.id, 'awaiting_settlement'));
    expect(awaiting.transition.to).toBe('awaiting_settlement');
    const trail = await database.db.select().from(auditLog).where(and(eq(auditLog.subjectId, t.id), eq(auditLog.action, 'tournament.drawn')));
    expect(trail.map((a) => (a.detail as { stage: string }).stage)).toEqual(['pools', 'pools', 'pools', 'bracket']);
  });

  it('draws single elimination straight from entry seeds, with byes only in round one', async () => {
    const t = await create({ format: 'single_elim', maxTeams: 8 });
    await transition(t.id, 'registration_open');
    const ids = await registerTeams(database, t.id, 6, { 0: 1, 1: 2, 2: 3 });
    await transition(t.id, 'registration_closed');

    const wrongStage = await runDraw(t.id, { stage: 'pools' });
    expect((await errorOf(wrongStage)).code).toBe('stage_not_applicable');

    const outcome = await data<DrawOutcome>(await runDraw(t.id, { stage: 'bracket', courts: 2, rngSeed: 3 }));
    expect(outcome.bracket).toMatchObject({ size: 8, rounds: 3 });
    expect(outcome.config).toMatchObject({ format: 'single_elim', courts: 2, rngSeed: 3 });
    const byes = outcome.matches.filter((m) => m.status === 'bye');
    expect(byes.map((m) => m.teamAId).sort()).toEqual([ids[0], ids[1]].sort());
    expect(byes.every((m) => m.round === 1)).toBe(true);
    const [saved] = await database.db.select().from(tournaments).where(eq(tournaments.id, t.id));
    expect(saved?.drawConfig).toEqual(outcome.config);
    expect(await database.db.select().from(pools).where(eq(pools.tournamentId, t.id))).toEqual([]);
    await transition(t.id, 'live');
    const detail = await data<PublicTournamentDetail>(await getTournament(request('GET', '/x'), params({ slug: t.slug })));
    expect(detail.pools).toEqual([]);
    expect(detail.bracket?.matches.filter((m) => m.status === 'bye')).toHaveLength(2);
  });

  it('draws a round robin as one pool and has no bracket stage', async () => {
    const t = await create({ format: 'round_robin', maxTeams: 8 });
    await transition(t.id, 'registration_open');
    await registerTeams(database, t.id, 5);
    await transition(t.id, 'registration_closed');
    const outcome = await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', courts: 2 }));
    expect(outcome.pools).toHaveLength(1);
    expect(outcome.pools[0]?.teamIds).toHaveLength(5);
    expect(outcome.matches).toHaveLength(10);
    expect(outcome.config).toMatchObject({ format: 'round_robin', courts: 2 });
    const bracket = await runDraw(t.id, { stage: 'bracket' });
    expect((await errorOf(bracket)).code).toBe('stage_not_applicable');
    expect(await database.db.select().from(poolTeams)).toHaveLength(5);
  });

  it('refuses double elimination with a specific error, and too small a field', async () => {
    // The API no longer offers double_elim; a row that carries it (the enum value stays) is refused at draw time.
    const [t] = await database.db
      .insert(tournaments)
      .values({
        id: newId('trn'),
        slug: 'double-trouble',
        name: 'Double Trouble',
        beneficiaryId: charity.id,
        venueName: 'v',
        venueCity: 'c',
        venueRegion: 'r',
        venueTimezone: 'UTC',
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 90_000_000),
        format: 'double_elim',
        division: 'open',
        maxTeams: 8,
        entryDonationCents: 0n,
        fundraisingGoalCents: 0n,
        status: 'registration_closed',
        purseExternalId: mintPurseExternalId('contest'),
      })
      .returning();
    if (t === undefined) throw new Error('tournament insert failed');
    await registerTeams(database, t.id, 4);
    const refused = await runDraw(t.id, { stage: 'bracket' });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({ type: 'invalid_state', code: 'double_elim_unsupported' });
    expect(await database.db.select().from(matches).where(eq(matches.tournamentId, t.id))).toEqual([]);

    const tiny = await create({ format: 'single_elim', slug: 'tiny', maxTeams: 8 });
    await transition(tiny.id, 'registration_open');
    await registerTeams(database, tiny.id, 1);
    await transition(tiny.id, 'registration_closed');
    const tooFew = await runDraw(tiny.id, { stage: 'bracket' });
    expect(tooFew.status).toBe(400);
    expect((await errorOf(tooFew)).code).toBe('draw_too_few_teams');
  });

  it('reopening registration discards the draw, and going live needs every counted team drawn', async () => {
    const t = await create({ maxTeams: 8, format: 'pool_to_bracket' });
    await transition(t.id, 'registration_open');
    await registerTeams(database, t.id, 6);
    await transition(t.id, 'registration_closed');
    await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 3, courts: 2, rngSeed: 1 }));
    expect(await database.db.select().from(pools).where(eq(pools.tournamentId, t.id))).toHaveLength(2);

    const reopened = await data<{ transition: { to: string } }>(await transition(t.id, 'registration_open'));
    expect(reopened.transition.to).toBe('registration_open');
    expect(await database.db.select().from(pools).where(eq(pools.tournamentId, t.id))).toEqual([]);
    expect(await database.db.select().from(matches).where(eq(matches.tournamentId, t.id))).toEqual([]);
    expect((await database.db.select().from(tournaments).where(eq(tournaments.id, t.id)))[0]?.drawConfig).toBeNull();
    const discarded = await database.db.select().from(auditLog).where(and(eq(auditLog.subjectId, t.id), eq(auditLog.action, 'tournament.draw_discarded')));
    expect(discarded).toHaveLength(1);
    expect(discarded[0]?.detail).toEqual({ reason: 'registration_reopened', pools: 2, matches: 6 });

    // A late team registers; without a draw there is no going live, and with a draw that
    // misses a counted team the refusal names the team.
    await registerTeams(database, t.id, 1);
    await transition(t.id, 'registration_closed');
    expect((await errorOf(await transition(t.id, 'live'))).code).toBe('draw_required');
    await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 4, courts: 2, rngSeed: 1 }));
    const [extra] = await registerTeams(database, t.id, 1);
    await database.db.update(teams).set({ name: 'Latecomers' }).where(eq(teams.id, extra ?? ''));
    const blocked = await transition(t.id, 'live');
    expect(blocked.status).toBe(409);
    const blockedError = await errorOf(blocked);
    expect(blockedError.code).toBe('teams_not_drawn');
    expect(blockedError.detail).toEqual({ teams: [{ id: extra, name: 'Latecomers' }] });
    expect(blockedError.message).toContain('Latecomers');

    const redrawn = await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 4, courts: 2, rngSeed: 2 }));
    expect(redrawn.pools.flatMap((p) => p.teamIds)).toContain(extra);
    expect((await data<{ transition: { to: string } }>(await transition(t.id, 'live'))).transition.to).toBe('live');
  });

  it('refuses to reopen registration once a drawn match has been decided', async () => {
    const t = await create({ maxTeams: 8, format: 'round_robin' });
    await transition(t.id, 'registration_open');
    await registerTeams(database, t.id, 3);
    await transition(t.id, 'registration_closed');
    await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', courts: 1, rngSeed: 1 }));
    const [first] = await database.db.select().from(matches).where(eq(matches.tournamentId, t.id));
    await forfeit(request('POST', '/x', { body: { forfeitingTeamId: first?.teamAId }, cookie: cookie() }), params({ id: first?.id ?? '' }));
    const reopen = await transition(t.id, 'registration_open');
    expect(reopen.status).toBe(409);
    expect((await errorOf(reopen)).code).toBe('draw_already_in_play');
    expect(await database.db.select().from(matches).where(eq(matches.tournamentId, t.id))).toHaveLength(3);
    expect((await database.db.select().from(tournaments).where(eq(tournaments.id, t.id)))[0]?.status).toBe('registration_closed');
  });

  it('redraws after a seeded team withdrew, and moving startsAt moves every scheduled match', async () => {
    const t = await create({ maxTeams: 8, format: 'pool_to_bracket' });
    await transition(t.id, 'registration_open');
    const ids = await registerTeams(database, t.id, 6);
    await transition(t.id, 'registration_closed');
    await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 3, courts: 2, rngSeed: 1, seeds: [{ teamId: ids[0] ?? '', seed: 1 }, { teamId: ids[1] ?? '', seed: 2 }] }));

    // A refund withdrew seed 2; the seed stays on the row until the next seeding replaces it.
    await database.db.update(teams).set({ status: 'withdrawn' }).where(eq(teams.id, ids[1] ?? ''));
    const reseeded = await data<DrawOutcome>(
      await runDraw(t.id, { stage: 'pools', poolSize: 3, courts: 2, rngSeed: 1, seeds: [{ teamId: ids[0] ?? '', seed: 1 }, { teamId: ids[2] ?? '', seed: 2 }] }),
    );
    expect(reseeded.pools.flatMap((p) => p.teamIds)).not.toContain(ids[1]);
    const seeds = await database.db.select({ id: teams.id, seed: teams.seed }).from(teams).where(eq(teams.tournamentId, t.id));
    expect(seeds.filter((s) => s.seed !== null).sort((x, y) => (x.seed ?? 0) - (y.seed ?? 0))).toEqual([{ id: ids[0], seed: 1 }, { id: ids[2], seed: 2 }]);
    const withdrawnSeed = await runDraw(t.id, { stage: 'pools', seeds: [{ teamId: ids[1] ?? '', seed: 1 }] });
    expect((await errorOf(withdrawnSeed)).code).toBe('draw_invalid_seed_list');

    // Moving the start shifts the derived schedule by the same delta, in the same transaction.
    const before = await database.db.select({ id: matches.id, scheduledAt: matches.scheduledAt }).from(matches).where(eq(matches.tournamentId, t.id));
    const [row] = await database.db.select().from(tournaments).where(eq(tournaments.id, t.id));
    const shift = 90 * 60_000;
    const moved = await patchTournament(
      request('PATCH', '/x', {
        body: { startsAt: new Date((row?.startsAt.getTime() ?? 0) + shift).toISOString(), endsAt: new Date((row?.endsAt.getTime() ?? 0) + shift).toISOString() },
        cookie: cookie(),
      }),
      params({ id: t.id }),
    );
    expect(moved.status).toBe(200);
    const after = await database.db.select({ id: matches.id, scheduledAt: matches.scheduledAt }).from(matches).where(eq(matches.tournamentId, t.id));
    expect(after).toHaveLength(before.length);
    for (const m of after) {
      const was = before.find((b) => b.id === m.id)?.scheduledAt?.getTime();
      expect(m.scheduledAt?.getTime()).toBe((was ?? 0) + shift);
    }
    const updated = await database.db.select().from(auditLog).where(and(eq(auditLog.subjectId, t.id), eq(auditLog.action, 'tournament.updated')));
    expect(updated.at(-1)?.detail).toMatchObject({ scheduleShiftMs: shift, matchesRescheduled: before.length });
    expect((updated.at(-1)?.detail as { fields: string[] }).fields.sort()).toEqual(['endsAt', 'startsAt']);

    // Once a match has started the start time is fixed.
    await transition(t.id, 'live');
    const [played] = await database.db.select().from(matches).where(eq(matches.tournamentId, t.id));
    await forfeit(request('POST', '/x', { body: { forfeitingTeamId: played?.teamAId }, cookie: cookie() }), params({ id: played?.id ?? '' }));
    const fixed = await patchTournament(
      request('PATCH', '/x', { body: { startsAt: new Date((row?.startsAt.getTime() ?? 0) + 2 * shift).toISOString() }, cookie: cookie() }),
      params({ id: t.id }),
    );
    expect(fixed.status).toBe(409);
    expect((await errorOf(fixed)).code).toBe('schedule_in_play');
    const unchanged = await database.db.select({ id: matches.id, scheduledAt: matches.scheduledAt }).from(matches).where(eq(matches.tournamentId, t.id));
    expect(unchanged.map((m) => m.scheduledAt?.getTime()).sort()).toEqual(after.map((m) => m.scheduledAt?.getTime()).sort());
  });

  it('will not settle a pool-to-bracket event whose bracket was never drawn', async () => {
    const t = await create({ maxTeams: 8, format: 'pool_to_bracket' });
    await transition(t.id, 'registration_open');
    await registerTeams(database, t.id, 4);
    await transition(t.id, 'registration_closed');
    await data<DrawOutcome>(await runDraw(t.id, { stage: 'pools', poolSize: 4, courts: 1, rngSeed: 1 }));
    await transition(t.id, 'live');
    const poolMatches = await database.db.select().from(matches).where(eq(matches.tournamentId, t.id));
    for (const m of poolMatches) await finishMatch(database, m.id, [{ setNumber: 1, teamAPoints: 21, teamBPoints: 12 }]);
    const settle = await transition(t.id, 'awaiting_settlement');
    expect(settle.status).toBe(409);
    expect((await errorOf(settle)).code).toBe('bracket_not_drawn');
    expect((await database.db.select().from(tournaments).where(eq(tournaments.id, t.id)))[0]?.status).toBe('live');
  });

  it('gates the draw and forfeit routes on organizers and validates the body', async () => {
    const player = await createUser(database);
    const t = await create({});
    expect((await draw(request('POST', '/x', { body: { stage: 'pools' }, cookie: cookieFor(player) }), params({ id: t.id }))).status).toBe(403);
    expect((await draw(request('POST', '/x', { body: { stage: 'pools' } }), params({ id: t.id }))).status).toBe(401);
    expect((await draw(request('POST', '/x', { body: { stage: 'losers' }, cookie: cookie() }), params({ id: t.id }))).status).toBe(400);
    expect((await forfeit(request('POST', '/x', { body: { forfeitingTeamId: 'tm_x' }, cookie: cookieFor(player) }), params({ id: 'mch_x' }))).status).toBe(403);
    const missing = await forfeit(request('POST', '/x', { body: { forfeitingTeamId: 'tm_x' }, cookie: cookie() }), params({ id: 'mch_00000000-0000-7000-8000-000000000000' }));
    expect(missing.status).toBe(404);
    const unknownMatch = await getMatch(request('GET', '/x'), params({ id: 'mch_00000000-0000-7000-8000-000000000000' }));
    expect(unknownMatch.status).toBe(404);
  });
});
