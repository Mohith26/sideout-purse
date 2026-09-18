import { count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Id } from '@repo/ids';

import {
  closeContest,
  ContestError,
  createContest,
  enterContest,
  previewSettlement,
  submitScores,
  transitionContest,
  voidContest,
  withdrawEntry,
  type ContestErrorCode,
  type ScoreSubmission,
} from '../../src/contests';
import type { Database } from '../../src/db/client';
import { contestParticipants, contestResults, contests, journalEntries, type Contest, type ContestState, type SettlementPolicy } from '../../src/db/schema';
import {
  balancesOf,
  escrowEntry,
  issuePromoPoints,
  LedgerError,
  reconcile,
  refundEscrow,
  reverseEntry,
  settleEscrow,
  signedDelta,
  voidEscrow,
  type LedgerErrorCode,
  type PostedEntry,
} from '../../src/ledger';
import type { Actor } from '../../src/ledger/audit';
import type { PrizeStructure } from '../../src/settlement';
import { connectMigrator, connectRuntime } from '../helpers';
import { buildWorld, rng, wipeLedger, type World } from './fixtures';

/**
 * Spec section 8 and acceptance criterion 1: `reconcile()` clean after ten thousand
 * randomized operations. This is the single highest-value test in the project.
 *
 * A seeded generator draws operations against a tenant with a promo account, a sponsor
 * account, N wallets and M escrows. Phase 1's ledger operations {issue, escrow, refund,
 * settle, void, replay, reversal, overdraft} post directly; phase 2 adds contest
 * operations {create, open, lock, start, declare results complete, cancel, enter,
 * withdraw, score, close via the preview hash, void, replay} that move the same wallets'
 * value through the contest engine. Most operations run in concurrent batches; an overdraft
 * attempt runs alone so its refusal is certain. Alongside the database a shadow model
 * replays the lines of every accepted entry, so at the end every account's derived balance
 * is checked against an independent bigint sum, every replay is shown to have created
 * nothing, every overdraft to have been refused, every contest's escrow to hold exactly its
 * live entries' stakes (or nothing once settled, voided or cancelled), and the seven
 * invariants to hold.
 *
 * LEDGER_RANDOM_OPS and LEDGER_RANDOM_SEED (apps/purse/.env.example) shape a run; CI
 * runs the full count and this test refuses a smaller one there.
 */
const FULL_COUNT = 10_000;
const OPS = readInt('LEDGER_RANDOM_OPS', FULL_COUNT);
const SEED = readInt('LEDGER_RANDOM_SEED', 20_260_917);
const WALLETS = 24;
const ESCROWS = 6;
const MODEL_CHECK_EVERY = 1000;
/** Share of the draws that become contest operations. */
const CONTEST_SHARE = 0.35;

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

const OPERATOR: Actor = { kind: 'operator', ref: 'random-ops' };

/** The contest engine as the model sees it: enough to draw sensible operations, never trusted over the database. */
type ModelContest = {
  id: string;
  escrowAccountId: string;
  entryAmount: bigint;
  policy: SettlementPolicy;
  state: ContestState;
  /** Users known to hold a stake (entered) or to have had it refunded (withdrawn). */
  participants: Map<string, 'entered' | 'withdrawn'>;
  finished: Set<string>;
};

type Op =
  | { kind: 'issue'; wallet: string; amount: bigint }
  | { kind: 'escrow'; wallet: string; escrow: string; amount: bigint }
  | { kind: 'refund'; held: Held }
  | { kind: 'settle'; escrow: string; payouts: Array<{ walletAccountId: string; amount: bigint }> }
  | { kind: 'void'; held: Held }
  | { kind: 'replay'; of: Posted }
  | { kind: 'reversal'; of: Posted }
  | { kind: 'overdraft'; wallet: string; amount: bigint }
  | { kind: 'c_create'; entryAmount: bigint; policy: SettlementPolicy; structure: PrizeStructure; max: number | null }
  | { kind: 'c_transition'; contest: ModelContest; to: 'open' | 'locked' | 'in_progress' | 'awaiting_settlement' | 'cancelled' }
  | { kind: 'c_enter'; contest: ModelContest; userId: string }
  | { kind: 'c_withdraw'; contest: ModelContest; userId: string }
  | { kind: 'c_score'; contest: ModelContest; scores: ScoreSubmission[] }
  | { kind: 'c_close'; contest: ModelContest; preview?: Promise<string> }
  | { kind: 'c_void'; contest: ModelContest }
  | { kind: 'c_replay'; of: PostedContestOp };

type Held = { entryId: string; wallet: string; escrow: string; amount: bigint };

/** An accepted ledger post and the exact call that produced it, so it can be replayed verbatim. */
type Posted = { entryId: string; key: string; kind: Op['kind']; run: (key: string) => Promise<Result> };

/** An accepted contest operation, likewise. */
type PostedContestOp = { key: string; kind: Op['kind']; contestId: string; entryIds: string[]; run: (key: string) => Promise<Result> };

/** Every service result normalised: the entries it posted, the contest it left behind, whether it was a replay. */
type Result = { entries: PostedEntry[]; contest?: Contest; replayed: boolean; contestModel?: ModelContest; settled?: boolean };

type Outcome = { op: Op; key: string; result: Result | LedgerError | ContestError };

type ContestOp = Extract<Op, { kind: `c_${string}` }>;

function isContestOp(op: Op): op is ContestOp {
  return op.kind.startsWith('c_');
}

const STATE_ORDER: ContestState[] = ['draft', 'open', 'locked', 'in_progress', 'awaiting_settlement', 'settling', 'settled'];

describe(`randomized operation sequence (${OPS} ops, seed ${SEED})`, () => {
  let migrator: Database;
  let runtime: Database;
  let world: World;

  beforeAll(async () => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 12 });
    await wipeLedger(migrator);
    world = await buildWorld(runtime.db, { wallets: WALLETS, escrows: ESCROWS });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('keeps every invariant, every derived balance, every contest escrow and every idempotent replay honest', { timeout: 30 * 60_000 }, async () => {
    if (process.env['CI'] !== undefined && OPS < FULL_COUNT) {
      throw new Error(`CI must run the full ${FULL_COUNT} operations; LEDGER_RANDOM_OPS=${OPS}`);
    }

    const random = rng(SEED);
    const normalSide = new Map([world.promo, world.sponsor, world.fee, ...world.wallets, ...world.escrows].map((a) => [a.id, a.normalSide]));
    const wallets = world.wallets.map((a) => a.id);
    const userOf = new Map(world.wallets.map((a) => [a.id, a.ownerRef ?? '']));
    const users = [...userOf.values()];
    const escrows = world.escrows.map((a) => a.id);
    const common = { tenantId: world.tenantId, asset: world.asset };

    // ---- the shadow model ------------------------------------------------------------
    const balance = new Map<string, bigint>([...normalSide.keys()].map((id) => [id, 0n]));
    const posted: Posted[] = [];
    const postedById = new Map<string, Posted>();
    const held: Held[] = [];
    const reversed = new Set<string>();
    const contestsModel: ModelContest[] = [];
    const contestOps: PostedContestOp[] = [];
    const stats = {
      batches: 0,
      largestBatch: 0,
      replays: 0,
      concurrentReplays: 0,
      overdraftsRefused: 0,
      refused: 0,
      reversals: 0,
      voids: 0,
      settles: 0,
      refunds: 0,
      escrows: 0,
      issues: 0,
      cCreated: 0,
      cTransitions: 0,
      cEntered: 0,
      cWithdrawn: 0,
      cScored: 0,
      cClosed: 0,
      cAutoSettled: 0,
      cVoided: 0,
      cCancelled: 0,
      cReplays: 0,
      cHashMismatches: 0,
      cRefused: 0,
    };
    let keyCounter = 0;
    const nextKey = (label: string) => `rand-${SEED}-${(keyCounter += 1)}-${label}`;

    const apply = (entry: PostedEntry): void => {
      for (const line of entry.lines) {
        const side = normalSide.get(line.accountId);
        if (side === undefined) throw new Error(`line on unknown account ${line.accountId}`);
        balance.set(line.accountId, (balance.get(line.accountId) ?? 0n) + signedDelta(side, line.direction, line.amount));
      }
    };
    const consume = (entryId: string): void => {
      const index = held.findIndex((h) => h.entryId === entryId);
      if (index >= 0) held.splice(index, 1);
    };
    /** States only move forward; the furthest state seen for a contest in a batch is its state. */
    const observe = (model: ModelContest, contest: Contest): void => {
      if (['settled', 'cancelled', 'voided'].includes(contest.state)) {
        model.state = contest.state;
        return;
      }
      if (STATE_ORDER.indexOf(contest.state) > STATE_ORDER.indexOf(model.state)) model.state = contest.state;
    };
    const byState = (...states: ContestState[]) => contestsModel.filter((c) => states.includes(c.state));
    const entered = (c: ModelContest) => [...c.participants].filter(([, s]) => s === 'entered').map(([u]) => u);

    // ---- operation generation --------------------------------------------------------
    const structures: PrizeStructure[] = [
      { type: 'winner_take_all' },
      { type: 'percentage_split', percentages: [50, 30, 20] },
      { type: 'top_n_equal', n: 3 },
      { type: 'placement_table', placements: [{ placement: 1, amount: '60' }, { placement: 2, amount: '40' }] },
      { type: 'guaranteed_minimum', minimums: ['5', '3'], percentages: [70, 30] },
      { type: 'percentage_split', percentages: [100], participationFloor: '1' },
    ];

    const LIVE_CONTESTS = 10;
    const generateContestOp = (): Op | undefined => {
      const bucket = random.next();
      const live = byState('draft', 'open', 'locked', 'in_progress', 'awaiting_settlement');
      const create = (): Op => ({
        kind: 'c_create',
        entryAmount: random.bigint(1n, 40n),
        policy: random.next() < 0.5 ? 'auto' : 'operator_close',
        structure: random.pick(structures),
        max: random.next() < 0.3 ? 1 + random.int(5) : null,
      });
      /** Push a contest along the happy path, the furthest-along first, so the whole lifecycle is exercised. */
      const push = (): Op | undefined => {
        const pools = [byState('in_progress'), byState('locked'), byState('open'), byState('draft')].filter((pool) => pool.length > 0);
        const pool = random.next() < 0.6 ? pools[0] : random.pick(pools.length > 0 ? pools : [[]]);
        if (pool === undefined || pool.length === 0) return live.length < LIVE_CONTESTS ? create() : undefined;
        const contest = random.pick(pool);
        const next = STATE_ORDER[STATE_ORDER.indexOf(contest.state) + 1];
        if (next === 'open' || next === 'locked' || next === 'in_progress' || next === 'awaiting_settlement') return { kind: 'c_transition', contest, to: next };
        return undefined;
      };
      if (live.length === 0 || (bucket < 0.08 && live.length < LIVE_CONTESTS)) return create();
      if (bucket < 0.26) return push();
      if (bucket < 0.5) {
        const open = byState('open');
        return open.length > 0 ? { kind: 'c_enter', contest: random.pick(open), userId: random.pick(users) } : push();
      }
      if (bucket < 0.55) {
        const withEntries = byState('open').filter((c) => entered(c).length > 0);
        if (withEntries.length === 0) return push();
        const contest = random.pick(withEntries);
        return { kind: 'c_withdraw', contest, userId: random.pick(entered(contest)) };
      }
      if (bucket < 0.76) {
        const scoring = byState('in_progress', 'awaiting_settlement').filter((c) => entered(c).length > 0);
        if (scoring.length === 0) return push();
        const contest = random.pick(scoring);
        const pool = entered(contest);
        const n = 1 + random.int(Math.min(3, pool.length));
        const chosen = [...new Set(Array.from({ length: n }, () => random.pick(pool)))];
        return {
          kind: 'c_score',
          contest,
          scores: chosen.map((userId) => ({ userId, score: random.next() < 0.1 ? null : random.int(11), attemptFinished: random.next() < 0.7 })),
        };
      }
      if (bucket < 0.86) {
        const awaiting = byState('awaiting_settlement');
        return awaiting.length > 0 ? { kind: 'c_close', contest: random.pick(awaiting) } : push();
      }
      if (bucket < 0.9) {
        const voidable = byState('open', 'locked', 'in_progress', 'awaiting_settlement').filter((c) => entered(c).length > 0);
        return voidable.length > 0 ? { kind: 'c_void', contest: random.pick(voidable) } : push();
      }
      if (bucket < 0.93) {
        const empty = byState('draft', 'open', 'locked', 'in_progress', 'awaiting_settlement').filter((c) => entered(c).length === 0);
        return empty.length > 0 ? { kind: 'c_transition', contest: random.pick(empty), to: 'cancelled' } : push();
      }
      return contestOps.length > 0 ? { kind: 'c_replay', of: random.pick(contestOps) } : push();
    };

    const generateLedgerOp = (roll: number): Op => {
      if (roll < 0.22 || posted.length === 0) {
        return { kind: 'issue', wallet: random.pick(wallets), amount: random.bigint(1n, 500n) };
      }
      if (roll < 0.44) {
        return { kind: 'escrow', wallet: random.pick(wallets), escrow: random.pick(escrows), amount: random.bigint(1n, 300n) };
      }
      if (roll < 0.52 && held.length > 0) return { kind: 'refund', held: random.pick(held) };
      if (roll < 0.6) {
        const funded = escrows.filter((id) => (balance.get(id) ?? 0n) > 0n);
        if (funded.length > 0) {
          const escrow = random.pick(funded);
          const total = balance.get(escrow) ?? 0n;
          const n = Math.min(Number(total), 1 + random.int(4));
          // Split `total` across n wallets, every share positive, summing exactly.
          const cuts = new Set<bigint>();
          while (cuts.size < n - 1) cuts.add(random.bigint(1n, total - 1n));
          const points = [0n, ...[...cuts].sort((a, b) => (a < b ? -1 : 1)), total];
          const payouts = points.slice(1).map((end, i) => ({ walletAccountId: random.pick(wallets), amount: end - (points[i] ?? 0n) }));
          return { kind: 'settle', escrow, payouts };
        }
      }
      if (roll < 0.68 && held.length > 0) return { kind: 'void', held: random.pick(held) };
      if (roll < 0.78) return { kind: 'replay', of: random.pick(posted) };
      if (roll < 0.86) {
        const candidates = posted.filter((p) => !reversed.has(p.entryId));
        if (candidates.length > 0) return { kind: 'reversal', of: random.pick(candidates) };
      }
      const wallet = random.pick(wallets);
      return { kind: 'overdraft', wallet, amount: (balance.get(wallet) ?? 0n) + random.bigint(1n, 100n) };
    };

    const generate = (): Op => {
      const roll = random.next();
      if (roll < CONTEST_SHARE) {
        const op = generateContestOp();
        if (op !== undefined) return op;
        return generateLedgerOp(random.next());
      }
      return generateLedgerOp((roll - CONTEST_SHARE) / (1 - CONTEST_SHARE));
    };

    // ---- execution -------------------------------------------------------------------
    const ledger = (promise: Promise<PostedEntry>): Promise<Result> => promise.then((entry) => ({ entries: [entry], replayed: entry.replayed }));

    const call = (op: Op, key: string): Promise<Result> => {
      switch (op.kind) {
        case 'issue':
          return ledger(issuePromoPoints(runtime.db, { ...common, promoLiabilityAccountId: world.promo.id, walletAccountId: op.wallet, amount: op.amount, idempotencyKey: key }));
        case 'escrow':
        case 'overdraft':
          return ledger(escrowEntry(runtime.db, { ...common, walletAccountId: op.wallet, escrowAccountId: op.kind === 'escrow' ? op.escrow : random.pick(escrows), amount: op.amount, idempotencyKey: key }));
        case 'refund':
          return ledger(refundEscrow(runtime.db, { ...common, escrowAccountId: op.held.escrow, walletAccountId: op.held.wallet, amount: op.held.amount, idempotencyKey: key }));
        case 'settle':
          return ledger(settleEscrow(runtime.db, { ...common, escrowAccountId: op.escrow, payouts: op.payouts, idempotencyKey: key }));
        case 'void':
          return ledger(voidEscrow(runtime.db, { tenantId: world.tenantId, entryId: op.held.entryId as Id<'je'>, idempotencyKey: key }));
        case 'replay':
          return op.of.run(op.of.key);
        case 'reversal':
          return ledger(reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: op.of.entryId as Id<'je'>, idempotencyKey: key }));
        case 'c_create':
          return createContest(runtime.db, {
            tenantId: world.tenantId,
            externalId: `rand-${SEED}-${key}`,
            kind: 'tournament',
            title: `Random ${key}`,
            asset: world.asset,
            entryAmount: op.entryAmount,
            maxParticipants: op.max,
            prizeStructure: op.structure,
            settlementPolicy: op.policy,
            idempotencyKey: key,
            actor: OPERATOR,
          }).then(({ contest, escrowAccount, replayed }) => {
            if (!normalSide.has(escrowAccount.id)) {
              normalSide.set(escrowAccount.id, escrowAccount.normalSide);
              balance.set(escrowAccount.id, 0n);
            }
            return { entries: [], contest, replayed, contestModel: { id: contest.id, escrowAccountId: escrowAccount.id, entryAmount: contest.entryAmount, policy: contest.settlementPolicy, state: contest.state, participants: new Map(), finished: new Set() } };
          });
        case 'c_transition':
          return transitionContest(runtime.db, { tenantId: world.tenantId, contestId: op.contest.id, to: op.to, actor: OPERATOR, idempotencyKey: key }).then(({ contest, replayed }) => ({ entries: [], contest, replayed }));
        case 'c_enter':
          return enterContest(runtime.db, { tenantId: world.tenantId, contestId: op.contest.id, userId: op.userId, idempotencyKey: key, actor: OPERATOR }).then(({ contest, entry, replayed }) => ({ entries: [entry], contest, replayed }));
        case 'c_withdraw':
          return withdrawEntry(runtime.db, { tenantId: world.tenantId, contestId: op.contest.id, userId: op.userId, idempotencyKey: key, actor: OPERATOR }).then(({ contest, refund, replayed }) => ({ entries: [refund], contest, replayed }));
        case 'c_score':
          return submitScores(runtime.db, { tenantId: world.tenantId, contestId: op.contest.id, scores: op.scores, idempotencyKey: key, actor: OPERATOR }).then(({ contest, settlement, replayed }) => ({
            entries: settlement?.entry === null || settlement === null ? [] : [settlement.entry],
            contest,
            replayed,
            settled: settlement !== null,
          }));
        case 'c_close':
          // One preview per close request, shared by a concurrent twin and by any later
          // replay: the hash is part of the request, so a replay must present the same one.
          op.preview ??= previewSettlement(runtime.db, { tenantId: world.tenantId, contestId: op.contest.id }).then((preview) => preview.payoutHash);
          return op.preview.then((payoutHash) =>
            closeContest(runtime.db, { tenantId: world.tenantId, contestId: op.contest.id, payoutHash, actor: OPERATOR, idempotencyKey: key }).then(({ contest, entry, replayed }) => ({
              entries: entry === null ? [] : [entry],
              contest,
              replayed,
            })),
          );
        case 'c_void':
          return voidContest(runtime.db, { tenantId: world.tenantId, contestId: op.contest.id, actor: OPERATOR, idempotencyKey: key }).then(({ contest, refunds, replayed }) => ({ entries: refunds, contest, replayed }));
        case 'c_replay':
          return op.of.run(op.of.key);
      }
    };

    /** Which refusals a concurrent run may legitimately produce for each operation. */
    const allowedLedger: Partial<Record<Op['kind'], LedgerErrorCode[]>> = {
      issue: [],
      escrow: ['insufficient_funds'],
      refund: ['insufficient_funds'],
      settle: ['insufficient_funds'],
      void: ['insufficient_funds', 'already_reversed'],
      replay: [],
      reversal: ['insufficient_funds', 'already_reversed'],
      overdraft: ['insufficient_funds'],
      c_enter: ['insufficient_funds'],
    };
    const allowedContest: Partial<Record<Op['kind'], ContestErrorCode[]>> = {
      c_transition: ['invalid_transition', 'contest_has_entries', 'operator_required'],
      c_enter: ['contest_not_open', 'already_entered', 'contest_full'],
      c_withdraw: ['invalid_contest_state', 'not_a_participant', 'participant_not_active'],
      c_score: ['scores_not_accepted', 'attempt_already_finished', 'participant_not_active', 'not_a_participant'],
      c_close: ['invalid_transition', 'preview_hash_mismatch', 'already_settled'],
      c_void: ['invalid_transition', 'already_voided'],
    };

    const execute = async (ops: Op[]): Promise<Outcome[]> => {
      // One key per operation object: an op that appears twice in a batch is the same
      // request fired twice at once, which is the concurrent replay case.
      const keys = new Map<Op, string>();
      const keyed = ops.map((op) => {
        const key = keys.get(op) ?? (op.kind === 'replay' ? op.of.key : op.kind === 'c_replay' ? op.of.key : nextKey(op.kind));
        keys.set(op, key);
        return { op, key };
      });
      const settled = await Promise.allSettled(keyed.map(({ op, key }) => call(op, key)));
      return settled.map((result, i) => {
        const { op, key } = keyed[i] ?? { op: { kind: 'issue', wallet: '', amount: 0n }, key: '' };
        if (result.status === 'fulfilled') return { op, key, result: result.value };
        if (result.reason instanceof LedgerError && (allowedLedger[op.kind] ?? []).includes(result.reason.code)) return { op, key, result: result.reason };
        if (result.reason instanceof ContestError && (allowedContest[op.kind] ?? []).includes(result.reason.code)) return { op, key, result: result.reason };
        throw new Error(`op #${i} ${op.kind} failed unexpectedly (seed ${SEED}): ${String(result.reason)}`, { cause: result.reason });
      });
    };

    const record = (outcomes: Outcome[]): void => {
      // Concurrent replays: every success under one key must be the same result, performed once.
      const byKey = new Map<string, Result[]>();
      for (const { key, result } of outcomes) {
        if (result instanceof LedgerError || result instanceof ContestError) continue;
        byKey.set(key, [...(byKey.get(key) ?? []), result]);
      }
      for (const [key, results] of byKey) {
        const ids = new Set(results.map((r) => r.entries.map((e) => e.entry.id).join(',') + (r.contest?.id ?? '')));
        expect(ids.size, `results under key ${key} agree`).toBe(1);
        const known = postedById.has(results[0]?.entries[0]?.entry.id ?? '') || contestOps.some((c) => c.key === key);
        expect(results.filter((r) => !r.replayed), `key ${key} performed once`).toHaveLength(known ? 0 : 1);
      }

      // Withdrawals after entries, so a same-batch enter/withdraw pair lands in the right order in the model.
      const ordered = [...outcomes].sort((a, b) => Number(a.op.kind === 'c_withdraw') - Number(b.op.kind === 'c_withdraw'));
      for (const { op, key, result } of ordered) {
        if (result instanceof LedgerError || result instanceof ContestError) {
          stats.refused += 1;
          if (op.kind === 'overdraft') stats.overdraftsRefused += 1;
          if (op.kind === 'void' || op.kind === 'refund') consume(op.held.entryId);
          if (isContestOp(op)) stats.cRefused += 1;
          if (result instanceof ContestError && result.code === 'preview_hash_mismatch') stats.cHashMismatches += 1;
          // A refusal that names the contest's real state teaches the model.
          if (result instanceof ContestError && 'contest' in op) {
            const named = result.detail['from'] ?? result.detail['state'];
            if (typeof named === 'string' && (STATE_ORDER as string[]).concat('cancelled', 'voided').includes(named)) {
              observe(op.contest, { state: named as ContestState } as Contest);
            }
          }
          if (result instanceof ContestError && op.kind === 'c_withdraw' && result.code === 'participant_not_active') op.contest.participants.set(op.userId, 'withdrawn');
          continue;
        }
        if (op.kind === 'overdraft') throw new Error(`overdraft on ${op.wallet} for ${op.amount} was accepted (seed ${SEED})`);
        if (op.kind === 'replay') {
          stats.replays += 1;
          expect(result.entries[0]?.entry.id).toBe(op.of.entryId);
          continue;
        }
        if (op.kind === 'c_replay') {
          stats.cReplays += 1;
          expect(result.replayed).toBe(true);
          expect(result.entries.map((e) => e.entry.id)).toEqual(op.of.entryIds);
          expect(result.contest?.id).toBe(op.of.contestId);
          continue;
        }
        if (result.replayed) {
          // The other half of a concurrent same-key pair got there first; nothing new to model.
          stats.concurrentReplays += 1;
          continue;
        }
        for (const entry of result.entries) apply(entry);

        if (isContestOp(op)) {
          const model = op.kind === 'c_create' ? result.contestModel : 'contest' in op ? op.contest : undefined;
          if (model === undefined) throw new Error(`no model for ${op.kind}`);
          if (op.kind === 'c_create') contestsModel.push(model);
          if (result.contest !== undefined) observe(model, result.contest);
          contestOps.push({ key, kind: op.kind, contestId: model.id, entryIds: result.entries.map((e) => e.entry.id), run: (k) => call(op, k) });
          switch (op.kind) {
            case 'c_create':
              stats.cCreated += 1;
              break;
            case 'c_transition':
              stats.cTransitions += 1;
              if (op.to === 'cancelled') stats.cCancelled += 1;
              break;
            case 'c_enter':
              stats.cEntered += 1;
              model.participants.set(op.userId, 'entered');
              break;
            case 'c_withdraw':
              stats.cWithdrawn += 1;
              model.participants.set(op.userId, 'withdrawn');
              break;
            case 'c_score':
              stats.cScored += 1;
              for (const each of op.scores) if (each.attemptFinished) model.finished.add(each.userId);
              if (result.settled === true) stats.cAutoSettled += 1;
              break;
            case 'c_close':
              stats.cClosed += 1;
              break;
            case 'c_void':
              stats.cVoided += 1;
              break;
          }
          continue;
        }

        const first = result.entries[0];
        if (first === undefined) throw new Error(`${op.kind} posted nothing`);
        const entry: Posted = { entryId: first.entry.id, key, kind: op.kind, run: (k) => call(op, k) };
        posted.push(entry);
        postedById.set(entry.entryId, entry);
        switch (op.kind) {
          case 'issue':
            stats.issues += 1;
            break;
          case 'escrow':
            stats.escrows += 1;
            held.push({ entryId: first.entry.id, wallet: op.wallet, escrow: op.escrow, amount: op.amount });
            break;
          case 'refund':
            stats.refunds += 1;
            consume(op.held.entryId);
            break;
          case 'settle':
            stats.settles += 1;
            for (const h of held.filter((h) => h.escrow === op.escrow)) consume(h.entryId);
            break;
          case 'void':
            stats.voids += 1;
            reversed.add(op.held.entryId);
            consume(op.held.entryId);
            break;
          case 'reversal':
            stats.reversals += 1;
            reversed.add(op.of.entryId);
            consume(op.of.entryId);
            break;
        }
      }
    };

    const checkModel = async (): Promise<void> => {
      const derived = await balancesOf(runtime.db, [...balance.keys()]);
      for (const [id, expected] of balance) expect(derived.get(id), `balance of ${id}`).toBe(expected);
      for (const id of wallets) expect(balance.get(id) ?? 0n).toBeGreaterThanOrEqual(0n);
      for (const id of escrows) expect(balance.get(id) ?? 0n).toBeGreaterThanOrEqual(0n);
    };

    // ---- the run -------------------------------------------------------------------------
    let done = 0;
    let sinceCheck = 0;
    while (done < OPS) {
      const op = generate();
      let batch: Op[];
      if (op.kind === 'overdraft') {
        batch = [op];
      } else {
        const size = Math.min(OPS - done, 1 + random.int(16));
        batch = [op];
        while (batch.length < size) {
          const next = generate();
          if (next.kind === 'overdraft') break;
          batch.push(next);
          // Sometimes fire an operation and its replay in the same batch.
          if (batch.length < size && random.next() < 0.15 && next.kind !== 'replay' && next.kind !== 'c_replay') batch.push(next);
        }
      }
      const outcomes = await execute(batch);
      record(outcomes);
      stats.batches += 1;
      stats.largestBatch = Math.max(stats.largestBatch, batch.length);
      done += batch.length;
      sinceCheck += batch.length;
      if (sinceCheck >= MODEL_CHECK_EVERY) {
        await checkModel();
        sinceCheck = 0;
      }
    }

    // ---- post-conditions ---------------------------------------------------------------
    await checkModel();

    const [rows] = await runtime.db.select({ n: count() }).from(journalEntries);
    const contestEntries = contestOps.reduce((sum, c) => sum + c.entryIds.length, 0);
    expect(rows?.n, 'replayed keys created nothing new').toBe(posted.length + contestEntries);

    // Every contest's escrow holds exactly its live entrants' stakes, or nothing once terminal.
    const liveRows = await runtime.db.select().from(contests).where(eq(contests.tenantId, world.tenantId));
    expect(liveRows).toHaveLength(contestsModel.length);
    for (const row of liveRows) {
      const [active] = await runtime.db
        .select({ n: count() })
        .from(contestParticipants)
        .where(inArray(contestParticipants.contestId, [row.id]));
      const entrants = await runtime.db.select().from(contestParticipants).where(eq(contestParticipants.contestId, row.id));
      const live = entrants.filter((p) => p.state === 'entered').length;
      const escrowed = balance.get(row.escrowAccountId) ?? 0n;
      expect(row.state, `${row.id} never rests in settling`).not.toBe('settling');
      if (row.state === 'settled' || row.state === 'voided' || row.state === 'cancelled') {
        expect(escrowed, `${row.id} (${row.state}) escrow`).toBe(0n);
      } else {
        expect(escrowed, `${row.id} (${row.state}) escrow`).toBe(BigInt(live) * row.entryAmount);
      }
      const [results] = await runtime.db.select({ n: count() }).from(contestResults).where(eq(contestResults.contestId, row.id));
      expect(results?.n, `${row.id} results`).toBe(row.state === 'settled' ? live : 0);
      expect(active?.n).toBe(entrants.length);
    }

    const report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok), 'reconcile must be clean').toEqual([]);
    expect(report.ok).toBe(true);

    // The generator exercised every operation, not just the easy ones.
    expect(done).toBeGreaterThanOrEqual(OPS);
    expect(stats.overdraftsRefused).toBeGreaterThan(0);
    expect(stats.replays).toBeGreaterThan(0);
    expect(stats.reversals).toBeGreaterThan(0);
    expect(stats.largestBatch).toBeGreaterThan(1);
    expect(stats.cCreated).toBeGreaterThan(0);
    expect(stats.cEntered).toBeGreaterThan(0);
    if (OPS >= FULL_COUNT) {
      for (const [name, value] of Object.entries(stats)) expect(value, `stat ${name}`).toBeGreaterThan(0);
      // The phase 1 bars, over the share of the run that is ledger operations.
      const ledgerOps = OPS * (1 - CONTEST_SHARE);
      expect(stats.overdraftsRefused).toBeGreaterThan(ledgerOps / 50);
      expect(stats.replays + stats.concurrentReplays).toBeGreaterThan(ledgerOps / 20);
      expect(stats.cClosed + stats.cAutoSettled).toBeGreaterThan(OPS / 500);
    }
  });
});
