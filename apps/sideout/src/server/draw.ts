import { randomInt } from 'node:crypto';

import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { newId } from '@repo/ids';
import { z } from 'zod';

import type { Db } from '../db/client';
import { matches, pools, poolTeams, sets, teams, tournaments, type MatchStatus, type Tournament } from '../db/schema';
import {
  assertDrawableFormat,
  drawBracket,
  drawPools,
  drawSingleElimination,
  DrawError,
  rankForBracket,
  type BracketDraw,
  type BracketSeedEntry,
  type DrawTeam,
  type PoolDraw,
} from '../domain/draw';
import {
  advancementRuleSchema,
  DRAW_CONFIG_VERSION,
  DRAW_DEFAULTS,
  drawConfigSchema,
  type DrawConfig,
  type PoolToBracketConfig,
  type RoundRobinConfig,
} from '../domain/draw-config';
import { createRng } from '../domain/rng';
import { isMatchComplete } from '../domain/state';
import type { Actor } from './actor';
import { writeAudit } from './audit';
import type { DbOrTx } from './db';
import { confirmedTeamsFilter } from './field';
import { failure } from './http/errors';
import { loadPoolStage, standingsForStage } from './standings';

/**
 * The draw service: reads the field, runs the pure engine, persists the result and the
 * configuration it was produced with. Two stages: `pools` (pool-to-bracket and round
 * robin) and `bracket` (the bracket from pool standings, or single elimination straight
 * from entry seeds). `preview` computes everything and writes nothing.
 */

const bestOf = z.union([z.literal(1), z.literal(3)]);

export const drawRequestSchema = z.object({
  stage: z.enum(['pools', 'bracket']),
  courts: z.number().int().min(1).max(64).optional(),
  poolSize: z.number().int().min(2).max(8).optional(),
  advancement: advancementRuleSchema.optional(),
  rngSeed: z.number().int().min(0).max(0xffff_ffff).optional(),
  bestOf: z.object({ pool: bestOf.optional(), bracket: bestOf.optional() }).optional(),
  /**
   * The organizer's entry seeds. When present it is the whole seeding: listed teams get
   * these seeds and every other team's seed is cleared. When absent, seeds are untouched.
   */
  seeds: z.array(z.object({ teamId: z.string().startsWith('tm_'), seed: z.number().int().min(1) })).max(128).optional(),
});

export type DrawRequest = z.infer<typeof drawRequestSchema>;

export const POOL_MATCH_MINUTES = 30;
export const BRACKET_MATCH_MINUTES = 45;
export const STAGE_BREAK_MINUTES = 15;

export type DrawOutcomeMatch = {
  poolSequence: number | null;
  round: number;
  bracketPosition: number | null;
  courtLabel: string;
  teamAId: string | null;
  teamBId: string | null;
  teamASeed: number | null;
  teamBSeed: number | null;
  bestOf: 1 | 3;
  status: MatchStatus;
  scheduledAt: string;
  nextPosition: number | null;
  nextSlot: 'a' | 'b' | null;
};

export type DrawOutcome = {
  stage: 'pools' | 'bracket';
  persisted: boolean;
  config: DrawConfig;
  pools: Array<{ sequence: number; label: string; courtLabel: string; teamIds: string[] }>;
  bracket: { size: number; rounds: number; seeds: BracketSeedEntry[] } | null;
  matches: DrawOutcomeMatch[];
};

function mapDrawError(error: unknown): never {
  if (error instanceof DrawError) {
    if (error.code === 'double_elim_unsupported') throw failure.invalidState('double_elim_unsupported', error.message);
    throw failure.invalidRequest(`draw_${error.code}`, error.message);
  }
  throw error;
}

function minutes(n: number): number {
  return n * 60_000;
}

export async function runDraw(
  db: Db,
  input: { tournamentId: string; request: DrawRequest; preview: boolean; actor: Actor; now: Date },
): Promise<DrawOutcome> {
  const { request, preview, now } = input;
  return db.transaction(async (tx) => {
    const query = tx.select().from(tournaments).where(eq(tournaments.id, input.tournamentId));
    const [tournament] = preview ? await query : await query.for('update');
    if (tournament === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');

    try {
      assertDrawableFormat(tournament.format);
    } catch (error) {
      mapDrawError(error);
    }
    const format = tournament.format;

    if (request.stage === 'pools' && format === 'single_elim') {
      throw failure.invalidRequest('stage_not_applicable', 'Single elimination has no pool stage; draw the bracket.');
    }
    if (request.stage === 'bracket' && format === 'round_robin') {
      throw failure.invalidRequest('stage_not_applicable', 'Round robin has no bracket; the pool standings are the result.');
    }

    // Entry seeds are read only by the stage that places teams from the seed line: the pools,
    // or the bracket of a single elimination. A pool-to-bracket bracket is seeded from standings.
    const drawsFromEntrySeeds = request.stage === 'pools' || format === 'single_elim';
    if (!drawsFromEntrySeeds && request.seeds !== undefined) {
      throw failure.invalidRequest('seeds_not_applicable', 'The bracket of a pool-to-bracket event is seeded from pool standings; entry seeds belong to the pools stage.');
    }
    const existing = await tx
      .select({ id: matches.id, poolId: matches.poolId, bracketPosition: matches.bracketPosition, status: matches.status, scheduledAt: matches.scheduledAt })
      .from(matches)
      .where(eq(matches.tournamentId, tournament.id));

    if (drawsFromEntrySeeds) {
      // The first (or only) stage: registration must be closed and nothing may have been played.
      if (tournament.status !== 'registration_closed') {
        throw failure.invalidState('draw_stage_not_allowed', `The ${format === 'single_elim' ? 'bracket' : 'pools'} are drawn once registration is closed; the tournament is ${tournament.status}.`);
      }
      const played = existing.filter((m) => m.status !== 'scheduled' && m.status !== 'bye');
      if (played.length > 0) {
        throw failure.invalidState('draw_already_in_play', `${played.length} match(es) have started; the draw cannot be replaced.`);
      }
    }

    if (request.stage === 'pools') {
      if (format === 'single_elim') throw failure.invalidRequest('stage_not_applicable', 'Single elimination has no pool stage; draw the bracket.');
      const field = await fieldWithSeeds(tx, tournament.id, request.seeds, preview);
      const config = poolsConfig(format, request);
      const draw = tryDraw(() =>
        drawPools({
          teams: field,
          poolSize: config.format === 'pool_to_bracket' ? config.poolSize : Math.max(2, field.length),
          courts: config.courts,
          bestOf: config.bestOf.pool,
          rng: createRng(config.rngSeed),
        }),
      );
      const outcome = poolsOutcome(config, draw, tournament.startsAt, preview);
      if (!preview) await persistPools(tx, { tournament, config, draw, outcome, actor: input.actor, now });
      return outcome;
    }

    // Bracket stage.
    if (format === 'single_elim') {
      const field = await fieldWithSeeds(tx, tournament.id, request.seeds, preview);
      const config: DrawConfig = {
        version: DRAW_CONFIG_VERSION,
        format: 'single_elim',
        courts: request.courts ?? DRAW_DEFAULTS.courts,
        rngSeed: request.rngSeed ?? randomInt(0, 0x1_0000_0000),
        bestOf: { bracket: request.bestOf?.bracket ?? DRAW_DEFAULTS.bestOf.bracket },
      };
      const draw = tryDraw(() => drawSingleElimination({ teams: field, courts: config.courts, bestOf: config.bestOf.bracket, rng: createRng(config.rngSeed) }));
      const outcome = bracketOutcome(config, draw, tournament.startsAt, preview);
      if (!preview) await persistBracket(tx, { tournament, config, draw, outcome, actor: input.actor, now, saveConfig: true });
      return outcome;
    }

    // Pool-to-bracket: the bracket reads the persisted pools-stage configuration back.
    if (tournament.status !== 'live') {
      throw failure.invalidState('draw_stage_not_allowed', `The bracket is drawn while the tournament is live; it is ${tournament.status}.`);
    }
    const parsedConfig = drawConfigSchema.safeParse(tournament.drawConfig);
    if (!parsedConfig.success || parsedConfig.data.format !== 'pool_to_bracket') {
      throw failure.invalidState('pools_not_drawn', 'Draw the pools before the bracket.');
    }
    const config = parsedConfig.data;
    const poolMatches = existing.filter((m) => m.poolId !== null);
    if (poolMatches.length === 0) throw failure.invalidState('pools_not_drawn', 'Draw the pools before the bracket.');
    const unfinished = poolMatches.filter((m) => !isMatchComplete(m.status));
    if (unfinished.length > 0) {
      throw failure.invalidState('pool_play_incomplete', `${unfinished.length} pool match(es) are not complete.`, {
        matches: unfinished.map((m) => ({ id: m.id, status: m.status })),
      });
    }
    const bracketInPlay = existing.filter((m) => m.bracketPosition !== null && m.status !== 'scheduled' && m.status !== 'bye');
    if (bracketInPlay.length > 0) {
      throw failure.invalidState('bracket_in_play', `${bracketInPlay.length} bracket match(es) have started; the bracket cannot be redrawn.`);
    }

    const stage = await loadPoolStage(tx, tournament.id);
    const standings = standingsForStage(stage);
    const seeds = tryDraw(() => rankForBracket(standings.map((s) => ({ sequence: s.sequence, standings: s.standings })), config.advancement));
    const draw = tryDraw(() => drawBracket({ seeds, courts: config.courts, bestOf: config.bestOf.bracket }));
    const lastPoolSlot = Math.max(...poolMatches.map((m) => m.scheduledAt?.getTime() ?? tournament.startsAt.getTime()));
    const bracketStart = new Date(lastPoolSlot + minutes(POOL_MATCH_MINUTES + STAGE_BREAK_MINUTES));
    const outcome = bracketOutcome(config, draw, bracketStart, preview);
    if (!preview) await persistBracket(tx, { tournament, config, draw, outcome, actor: input.actor, now, saveConfig: false });
    return outcome;
  });
}

function tryDraw<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    return mapDrawError(error);
  }
}

function poolsConfig(format: 'pool_to_bracket' | 'round_robin', request: DrawRequest): PoolToBracketConfig | RoundRobinConfig {
  const rngSeed = request.rngSeed ?? randomInt(0, 0x1_0000_0000);
  const courts = request.courts ?? DRAW_DEFAULTS.courts;
  if (format === 'round_robin') {
    return { version: DRAW_CONFIG_VERSION, format, courts, rngSeed, bestOf: { pool: request.bestOf?.pool ?? DRAW_DEFAULTS.bestOf.pool } };
  }
  return {
    version: DRAW_CONFIG_VERSION,
    format,
    courts,
    poolSize: request.poolSize ?? DRAW_DEFAULTS.poolSize,
    advancement: request.advancement ?? DRAW_DEFAULTS.advancement,
    rngSeed,
    bestOf: { pool: request.bestOf?.pool ?? DRAW_DEFAULTS.bestOf.pool, bracket: request.bestOf?.bracket ?? DRAW_DEFAULTS.bestOf.bracket },
  };
}

/**
 * The confirmed teams (entry donation succeeded, or free entry) with their entry seeds,
 * after applying the request's seed list. In a preview the list is applied to the
 * in-memory field only.
 */
async function fieldWithSeeds(tx: DbOrTx, tournamentId: string, seedList: DrawRequest['seeds'], preview: boolean): Promise<DrawTeam[]> {
  const rows = await tx.select({ id: teams.id, seed: teams.seed }).from(teams).where(confirmedTeamsFilter(tournamentId)).orderBy(asc(teams.createdAt));
  if (seedList === undefined) return rows;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<number>();
  for (const entry of seedList) {
    if (!byId.has(entry.teamId)) throw failure.invalidRequest('draw_invalid_seed_list', `Team ${entry.teamId} is not a confirmed entry in this tournament.`);
    if (seen.has(entry.seed)) throw failure.invalidRequest('draw_invalid_seed_list', `Seed ${entry.seed} is assigned twice.`);
    seen.add(entry.seed);
  }
  const seeded = new Map(seedList.map((s) => [s.teamId, s.seed]));
  const field = rows.map((r) => ({ id: r.id, seed: seeded.get(r.id) ?? null }));
  if (!preview) {
    // Clear every team's seed first (withdrawn ones included) so a seed moving between
    // teams never trips the unique index mid-way.
    await tx.update(teams).set({ seed: null }).where(eq(teams.tournamentId, tournamentId));
    for (const entry of seedList) await tx.update(teams).set({ seed: entry.seed }).where(eq(teams.id, entry.teamId));
  }
  return field;
}

/** Remove every pool, pool membership, match and set of a tournament, and say how many of each went. */
export async function deleteDraw(tx: DbOrTx, tournamentId: string): Promise<{ matches: number; pools: number }> {
  const matchIds = (await tx.select({ id: matches.id }).from(matches).where(eq(matches.tournamentId, tournamentId))).map((m) => m.id);
  if (matchIds.length > 0) {
    await tx.delete(sets).where(inArray(sets.matchId, matchIds));
    await tx.delete(matches).where(eq(matches.tournamentId, tournamentId));
  }
  const poolIds = (await tx.select({ id: pools.id }).from(pools).where(eq(pools.tournamentId, tournamentId))).map((p) => p.id);
  if (poolIds.length > 0) {
    await tx.delete(poolTeams).where(inArray(poolTeams.poolId, poolIds));
    await tx.delete(pools).where(eq(pools.tournamentId, tournamentId));
  }
  return { matches: matchIds.length, pools: poolIds.length };
}

function poolsOutcome(config: DrawConfig, draw: PoolDraw, startsAt: Date, preview: boolean): DrawOutcome {
  return {
    stage: 'pools',
    persisted: !preview,
    config,
    pools: draw.pools.map((p) => ({ sequence: p.sequence, label: p.label, courtLabel: p.courtLabel, teamIds: p.teamIds })),
    bracket: null,
    matches: draw.matches.map((m) => ({
      poolSequence: m.poolSequence,
      round: m.round,
      bracketPosition: null,
      courtLabel: m.courtLabel,
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      teamASeed: null,
      teamBSeed: null,
      bestOf: m.bestOf,
      status: 'scheduled',
      scheduledAt: new Date(startsAt.getTime() + m.courtSlot * minutes(POOL_MATCH_MINUTES)).toISOString(),
      nextPosition: null,
      nextSlot: null,
    })),
  };
}

function bracketOutcome(config: DrawConfig, draw: BracketDraw, startsAt: Date, preview: boolean): DrawOutcome {
  const seeds: BracketSeedEntry[] = draw.matches
    .filter((m) => m.round === 1)
    .flatMap((m) => [
      m.teamAId === null || m.teamASeed === null ? [] : [{ teamId: m.teamAId, seed: m.teamASeed }],
      m.teamBId === null || m.teamBSeed === null ? [] : [{ teamId: m.teamBId, seed: m.teamBSeed }],
    ])
    .flat()
    .sort((x, y) => x.seed - y.seed);
  return {
    stage: 'bracket',
    persisted: !preview,
    config,
    pools: [],
    bracket: { size: draw.size, rounds: draw.rounds, seeds },
    matches: draw.matches.map((m) => ({
      poolSequence: null,
      round: m.round,
      bracketPosition: m.position,
      courtLabel: m.courtLabel,
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      teamASeed: m.teamASeed,
      teamBSeed: m.teamBSeed,
      bestOf: m.bestOf,
      status: m.isBye ? 'bye' : 'scheduled',
      scheduledAt: new Date(startsAt.getTime() + m.courtSlot * minutes(BRACKET_MATCH_MINUTES)).toISOString(),
      nextPosition: m.nextPosition,
      nextSlot: m.nextSlot,
    })),
  };
}

async function persistPools(
  tx: DbOrTx,
  input: { tournament: Tournament; config: DrawConfig; draw: PoolDraw; outcome: DrawOutcome; actor: Actor; now: Date },
): Promise<void> {
  const { tournament, now } = input;
  // Replace any earlier draw wholesale; the guard above proved nothing has been played.
  const replaced = await deleteDraw(tx, tournament.id);

  const poolIds = new Map<number, string>();
  for (const pool of input.draw.pools) {
    const id = newId('pol');
    poolIds.set(pool.sequence, id);
    await tx.insert(pools).values({ id, tournamentId: tournament.id, label: pool.label, sequence: pool.sequence, courtLabel: pool.courtLabel, createdAt: now });
    await tx.insert(poolTeams).values(pool.teamIds.map((teamId, index) => ({ id: newId('plt'), poolId: id, teamId, position: index + 1, createdAt: now })));
  }
  for (const match of input.outcome.matches) {
    const poolId = match.poolSequence === null ? undefined : poolIds.get(match.poolSequence);
    if (poolId === undefined) throw new Error('persistPools: match without a pool');
    await tx.insert(matches).values({
      id: newId('mch'),
      tournamentId: tournament.id,
      poolId,
      round: match.round,
      bracketPosition: null,
      courtLabel: match.courtLabel,
      teamAId: match.teamAId,
      teamBId: match.teamBId,
      bestOf: match.bestOf,
      status: 'scheduled',
      scheduledAt: new Date(match.scheduledAt),
      createdAt: now,
      updatedAt: now,
    });
  }
  await tx.update(tournaments).set({ drawConfig: input.config, updatedAt: now }).where(eq(tournaments.id, tournament.id));
  await writeAudit(tx, {
    actor: input.actor,
    action: 'tournament.drawn',
    subjectType: 'tournament',
    subjectId: tournament.id,
    detail: { stage: 'pools', config: input.config, pools: input.draw.pools.length, matches: input.outcome.matches.length, replaced: replaced.matches > 0 },
    at: now,
  });
}

async function persistBracket(
  tx: DbOrTx,
  input: { tournament: Tournament; config: DrawConfig; draw: BracketDraw; outcome: DrawOutcome; actor: Actor; now: Date; saveConfig: boolean },
): Promise<void> {
  const { tournament, now } = input;
  const previous = (
    await tx.select({ id: matches.id }).from(matches).where(and(eq(matches.tournamentId, tournament.id), isNotNull(matches.bracketPosition)))
  ).map((m) => m.id);
  if (previous.length > 0) {
    await tx.delete(sets).where(inArray(sets.matchId, previous));
    await tx.delete(matches).where(and(eq(matches.tournamentId, tournament.id), isNotNull(matches.bracketPosition)));
  }

  const ids = new Map<number, string>();
  for (const match of input.outcome.matches) {
    if (match.bracketPosition === null) continue;
    ids.set(match.bracketPosition, newId('mch'));
  }
  for (const match of input.outcome.matches) {
    if (match.bracketPosition === null) continue;
    const isBye = match.status === 'bye';
    await tx.insert(matches).values({
      id: ids.get(match.bracketPosition) ?? '',
      tournamentId: tournament.id,
      poolId: null,
      round: match.round,
      bracketPosition: match.bracketPosition,
      courtLabel: isBye ? null : match.courtLabel,
      teamAId: match.teamAId,
      teamBId: match.teamBId,
      teamASeed: match.teamASeed,
      teamBSeed: match.teamBSeed,
      bestOf: match.bestOf,
      status: match.status,
      winnerTeamId: isBye ? match.teamAId : null,
      finalizedAt: isBye ? now : null,
      scheduledAt: isBye ? null : new Date(match.scheduledAt),
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const match of input.outcome.matches) {
    if (match.bracketPosition === null || match.nextPosition === null || match.nextSlot === null) continue;
    await tx
      .update(matches)
      .set({ nextMatchId: ids.get(match.nextPosition) ?? null, nextMatchSlot: match.nextSlot })
      .where(eq(matches.id, ids.get(match.bracketPosition) ?? ''));
  }
  for (const match of input.outcome.matches) {
    if (match.status !== 'bye' || match.bracketPosition === null) continue;
    await writeAudit(tx, {
      actor: { kind: 'system', userId: null },
      action: 'match.bye',
      subjectType: 'match',
      subjectId: ids.get(match.bracketPosition) ?? '',
      detail: { teamId: match.teamAId, seed: match.teamASeed, advancedTo: match.nextPosition === null ? null : ids.get(match.nextPosition) },
      at: now,
    });
  }
  if (input.saveConfig) {
    await tx.update(tournaments).set({ drawConfig: input.config, updatedAt: now }).where(eq(tournaments.id, tournament.id));
  }
  await writeAudit(tx, {
    actor: input.actor,
    action: 'tournament.drawn',
    subjectType: 'tournament',
    subjectId: tournament.id,
    detail: {
      stage: 'bracket',
      config: input.config,
      size: input.draw.size,
      rounds: input.draw.rounds,
      byes: input.outcome.matches.filter((m) => m.status === 'bye').length,
      seeds: input.outcome.bracket?.seeds ?? [],
      replaced: previous.length > 0,
    },
    at: now,
  });
}
