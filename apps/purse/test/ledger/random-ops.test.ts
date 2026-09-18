import { count } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Id } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { journalEntries } from '../../src/db/schema';
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
import { connectMigrator, connectRuntime } from '../helpers';
import { buildWorld, rng, wipeLedger, type World } from './fixtures';

/**
 * Spec section 8 and acceptance criterion 1: `reconcile()` clean after ten thousand
 * randomized operations. This is the single highest-value test in the project.
 *
 * A seeded generator draws operations from {issue, escrow, refund, settle, void,
 * replay, reversal, overdraft} against a tenant with a promo account, a sponsor account,
 * N wallets and M escrows. Most operations run in concurrent batches; an overdraft
 * attempt runs alone so its refusal is certain. Alongside the database a shadow model
 * replays the lines of every accepted entry, so at the end every account's derived
 * balance is checked against an independent bigint sum, every replay is shown to have
 * created nothing, every overdraft to have been refused, and the seven invariants to hold.
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

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

type Op =
  | { kind: 'issue'; wallet: string; amount: bigint }
  | { kind: 'escrow'; wallet: string; escrow: string; amount: bigint }
  | { kind: 'refund'; held: Held }
  | { kind: 'settle'; escrow: string; payouts: Array<{ walletAccountId: string; amount: bigint }> }
  | { kind: 'void'; held: Held }
  | { kind: 'replay'; of: Posted }
  | { kind: 'reversal'; of: Posted }
  | { kind: 'overdraft'; wallet: string; amount: bigint };

type Held = { entryId: string; wallet: string; escrow: string; amount: bigint };

/** An accepted post and the exact call that produced it, so it can be replayed verbatim. */
type Posted = { entryId: string; key: string; kind: Op['kind']; run: (key: string) => Promise<PostedEntry> };

type Outcome = { op: Op; key: string; result: PostedEntry | LedgerError };

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

  it('keeps every invariant, every derived balance and every idempotent replay honest', { timeout: 20 * 60_000 }, async () => {
    if (process.env['CI'] !== undefined && OPS < FULL_COUNT) {
      throw new Error(`CI must run the full ${FULL_COUNT} operations; LEDGER_RANDOM_OPS=${OPS}`);
    }

    const random = rng(SEED);
    const normalSide = new Map([world.promo, world.sponsor, world.fee, ...world.wallets, ...world.escrows].map((a) => [a.id, a.normalSide]));
    const wallets = world.wallets.map((a) => a.id);
    const escrows = world.escrows.map((a) => a.id);
    const common = { tenantId: world.tenantId, asset: world.asset };

    // ---- the shadow model ------------------------------------------------------------
    const balance = new Map<string, bigint>([...normalSide.keys()].map((id) => [id, 0n]));
    const posted: Posted[] = [];
    const postedById = new Map<string, Posted>();
    const held: Held[] = [];
    const reversed = new Set<string>();
    const stats = { batches: 0, largestBatch: 0, replays: 0, concurrentReplays: 0, overdraftsRefused: 0, refused: 0, reversals: 0, voids: 0, settles: 0, refunds: 0, escrows: 0, issues: 0 };
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

    // ---- operation generation --------------------------------------------------------
    const generate = (): Op => {
      const roll = random.next();
      if (roll < 0.22 || posted.length === 0) {
        return { kind: 'issue', wallet: random.pick(wallets), amount: random.bigint(1n, 500n) };
      }
      if (roll < 0.44) {
        return { kind: 'escrow', wallet: random.pick(wallets), escrow: random.pick(escrows), amount: random.bigint(1n, 300n) };
      }
      if (roll < 0.52 && held.length > 0) return { kind: 'refund', held: random.pick(held) };
      if (roll < 0.60) {
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

    const call = (op: Op, key: string): Promise<PostedEntry> => {
      switch (op.kind) {
        case 'issue':
          return issuePromoPoints(runtime.db, { ...common, promoLiabilityAccountId: world.promo.id, walletAccountId: op.wallet, amount: op.amount, idempotencyKey: key });
        case 'escrow':
        case 'overdraft':
          return escrowEntry(runtime.db, { ...common, walletAccountId: op.wallet, escrowAccountId: op.kind === 'escrow' ? op.escrow : random.pick(escrows), amount: op.amount, idempotencyKey: key });
        case 'refund':
          return refundEscrow(runtime.db, { ...common, escrowAccountId: op.held.escrow, walletAccountId: op.held.wallet, amount: op.held.amount, idempotencyKey: key });
        case 'settle':
          return settleEscrow(runtime.db, { ...common, escrowAccountId: op.escrow, payouts: op.payouts, idempotencyKey: key });
        case 'void':
          return voidEscrow(runtime.db, { tenantId: world.tenantId, entryId: op.held.entryId as Id<'je'>, idempotencyKey: key });
        case 'replay':
          return op.of.run(op.of.key);
        case 'reversal':
          return reverseEntry(runtime.db, { tenantId: world.tenantId, entryId: op.of.entryId as Id<'je'>, idempotencyKey: key });
      }
    };

    /** Which refusals a concurrent run may legitimately produce for each operation. */
    const allowed: Record<Op['kind'], LedgerErrorCode[]> = {
      issue: [],
      escrow: ['insufficient_funds'],
      refund: ['insufficient_funds'],
      settle: ['insufficient_funds'],
      void: ['insufficient_funds', 'already_reversed'],
      replay: [],
      reversal: ['insufficient_funds', 'already_reversed'],
      overdraft: ['insufficient_funds'],
    };

    const execute = async (ops: Op[]): Promise<Outcome[]> => {
      // One key per operation object: an op that appears twice in a batch is the same
      // request fired twice at once, which is the concurrent replay case.
      const keys = new Map<Op, string>();
      const keyed = ops.map((op) => {
        const key = keys.get(op) ?? (op.kind === 'replay' ? op.of.key : nextKey(op.kind));
        keys.set(op, key);
        return { op, key };
      });
      const settled = await Promise.allSettled(keyed.map(({ op, key }) => call(op, key)));
      return settled.map((result, i) => {
        const { op, key } = keyed[i] ?? { op: { kind: 'issue', wallet: '', amount: 0n }, key: '' };
        if (result.status === 'fulfilled') return { op, key, result: result.value };
        if (result.reason instanceof LedgerError && allowed[op.kind].includes(result.reason.code)) return { op, key, result: result.reason };
        throw new Error(`op #${i} ${op.kind} failed unexpectedly (seed ${SEED}): ${String(result.reason)}`, { cause: result.reason });
      });
    };

    const record = (outcomes: Outcome[]): void => {
      // Concurrent replays: every success under one key must be the same entry, posted once.
      const byKey = new Map<string, PostedEntry[]>();
      for (const { key, result } of outcomes) {
        if (result instanceof LedgerError) continue;
        byKey.set(key, [...(byKey.get(key) ?? []), result]);
      }
      for (const [, entries] of byKey) {
        expect(new Set(entries.map((e) => e.entry.id)).size).toBe(1);
        expect(entries.filter((e) => !e.replayed)).toHaveLength(postedById.has(entries[0]?.entry.id ?? '') ? 0 : 1);
      }

      for (const { op, key, result } of outcomes) {
        if (result instanceof LedgerError) {
          stats.refused += 1;
          if (op.kind === 'overdraft') stats.overdraftsRefused += 1;
          if (op.kind === 'void' || op.kind === 'refund') consume(op.held.entryId);
          continue;
        }
        if (op.kind === 'overdraft') throw new Error(`overdraft on ${op.wallet} for ${op.amount} was accepted (seed ${SEED})`);
        if (op.kind === 'replay') {
          stats.replays += 1;
          expect(result.entry.id).toBe(op.of.entryId);
          continue;
        }
        if (result.replayed) {
          // The other half of a concurrent same-key pair got there first; nothing new to model.
          stats.concurrentReplays += 1;
          continue;
        }
        apply(result);
        const entry: Posted = { entryId: result.entry.id, key, kind: op.kind, run: (k) => call(op, k) };
        posted.push(entry);
        postedById.set(entry.entryId, entry);
        switch (op.kind) {
          case 'issue':
            stats.issues += 1;
            break;
          case 'escrow':
            stats.escrows += 1;
            held.push({ entryId: result.entry.id, wallet: op.wallet, escrow: op.escrow, amount: op.amount });
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
          if (batch.length < size && random.next() < 0.15 && next.kind !== 'replay') batch.push(next);
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
    expect(rows?.n, 'replayed keys created nothing new').toBe(posted.length);

    const report = await reconcile(runtime.db);
    expect(report.invariants.filter((r) => !r.ok), 'reconcile must be clean').toEqual([]);
    expect(report.ok).toBe(true);

    // The generator exercised every operation, not just the easy ones.
    expect(done).toBeGreaterThanOrEqual(OPS);
    expect(stats.overdraftsRefused).toBeGreaterThan(0);
    expect(stats.replays).toBeGreaterThan(0);
    expect(stats.reversals).toBeGreaterThan(0);
    expect(stats.largestBatch).toBeGreaterThan(1);
    if (OPS >= FULL_COUNT) {
      for (const [name, value] of Object.entries(stats)) expect(value, `stat ${name}`).toBeGreaterThan(0);
      expect(stats.overdraftsRefused).toBeGreaterThan(OPS / 50);
      expect(stats.replays + stats.concurrentReplays).toBeGreaterThan(OPS / 20);
    }
  });
});
