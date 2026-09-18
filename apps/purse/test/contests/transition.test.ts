import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  canTransition,
  CONTEST_STATES,
  createContest,
  getContest,
  TRANSITION_ACTIONS,
  TRANSITIONS,
  transition,
  transitionContest,
  updateContest,
} from '../../src/contests';
import type { Database } from '../../src/db/client';
import { auditLog, contests, type ContestState } from '../../src/db/schema';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { key, wipeLedger } from '../ledger/fixtures';
import { advance, buildArena, contestError, makeContest, openWithEntrants, OPERATOR, TENANT_ACTOR, USER_ACTOR, type Arena } from './fixtures';

/**
 * Spec 4.3: the lifecycle, the single `transition()` function that validates the source
 * state under `SELECT ... FOR UPDATE` and writes `audit_log`, and the operator assertion
 * for leaving `awaiting_settlement` under `operator_close`.
 */
describe('the transition table', () => {
  it('is the spec 4.3 diagram', () => {
    expect(TRANSITIONS).toEqual({
      draft: ['open', 'cancelled'],
      open: ['locked', 'cancelled', 'voided'],
      locked: ['in_progress', 'cancelled', 'voided'],
      in_progress: ['awaiting_settlement', 'cancelled', 'voided'],
      awaiting_settlement: ['settling', 'cancelled', 'voided'],
      settling: ['settled'],
      settled: [],
      cancelled: [],
      voided: [],
    });
    expect(CONTEST_STATES).toHaveLength(9);
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('open', 'draft')).toBe(false);
    expect(canTransition('settled', 'open')).toBe(false);
    for (const state of CONTEST_STATES) expect(TRANSITION_ACTIONS[state]).toMatch(/^contest\./);
  });
});

describe('transition()', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 8 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 3 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('walks the happy path, writing an audit row with before and after at every step', async () => {
    const contest = await makeContest(runtime.db, arena);
    expect(contest.state).toBe('draft');
    expect(contest.settledAt).toBeNull();

    const opened = await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR, reason: 'registration opens' });
    expect(opened.before.state).toBe('draft');
    expect(opened.after.state).toBe('open');
    expect(opened.after.updatedAt.getTime()).toBeGreaterThanOrEqual(opened.before.updatedAt.getTime());

    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'locked', actor: TENANT_ACTOR });
    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'in_progress', actor: TENANT_ACTOR });
    const awaiting = await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'awaiting_settlement', actor: OPERATOR });
    expect(awaiting.after.state).toBe('awaiting_settlement');

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id)).orderBy(auditLog.createdAt, auditLog.id);
    expect(audit.map((row) => row.action)).toEqual(['contest.created', 'contest.opened', 'contest.locked', 'contest.started', 'contest.awaiting_settlement']);
    expect(audit[1]).toMatchObject({ actorKind: 'operator', actorRef: 'op_test', tenantId: arena.tenantId });
    expect(audit[1]?.before).toMatchObject({ id: contest.id, state: 'draft' });
    expect(audit[1]?.after).toMatchObject({ id: contest.id, state: 'open', reason: 'registration opens' });
    expect(audit[2]).toMatchObject({ actorKind: 'tenant', actorRef: 'sideout' });
    expect(audit[2]?.before).toMatchObject({ state: 'open' });
    expect(audit[2]?.after).toMatchObject({ state: 'locked' });
    // Amounts are strings in the audit row, never floats.
    expect(audit[1]?.after?.['entryAmount']).toBe('100');
  });

  it('refuses every pair the table does not list, naming the allowed destinations', async () => {
    const contest = await makeContest(runtime.db, arena);
    for (const to of CONTEST_STATES) {
      if (canTransition('draft', to)) continue;
      const error = await contestError(transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to, actor: OPERATOR }));
      expect(error.code).toBe('invalid_transition');
      expect(error.apiType).toBe('invalid_state');
      expect(error.detail).toMatchObject({ from: 'draft', to, allowed: ['open', 'cancelled'] });
    }
    const [row] = await runtime.db.select().from(contests).where(eq(contests.id, contest.id));
    expect(row?.state).toBe('draft');
  });

  it('the database holds the same table: every (from, to) pair the trigger accepts is one the code accepts', async () => {
    const contest = await makeContest(runtime.db, arena);
    const accepted: string[] = [];
    for (const from of CONTEST_STATES) {
      for (const to of CONTEST_STATES) {
        if (from === to) continue;
        // As the owner, in a transaction that is rolled back: force `from`, then try `to`.
        const outcome = await migrator.sql
          .begin(async (tx) => {
            await tx`alter table contests disable trigger contests_state_machine`;
            await tx`update contests set state = ${from}::contest_state, settled_at = ${from === 'settled' ? new Date().toISOString() : null}::timestamptz where id = ${contest.id}`;
            await tx`alter table contests enable trigger contests_state_machine`;
            await tx`update contests set state = ${to}::contest_state, settled_at = ${to === 'settled' ? new Date().toISOString() : null}::timestamptz where id = ${contest.id}`;
            throw new Error('rollback');
          })
          .then(
            () => 'committed',
            (error: unknown) => (error instanceof Error && error.message === 'rollback' ? 'accepted' : String(error)),
          );
        if (outcome === 'accepted') accepted.push(`${from}->${to}`);
        else expect(outcome, `${from}->${to}`).toMatch(new RegExp(`cannot move from ${from} to ${to}`));
      }
    }
    const expected = CONTEST_STATES.flatMap((from) => TRANSITIONS[from].map((to) => `${from}->${to}`));
    expect(accepted.sort()).toEqual(expected.sort());
  });

  it('a user actor never moves a contest', async () => {
    const contest = await makeContest(runtime.db, arena);
    const error = await contestError(transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: USER_ACTOR }));
    expect(error.code).toBe('actor_not_allowed');
    expect(error.apiType).toBe('permission_error');
  });

  it('under operator_close, only an operator can leave awaiting_settlement, wherever it is going', async () => {
    const contest = await makeContest(runtime.db, arena, { settlementPolicy: 'operator_close' });
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    for (const actor of [TENANT_ACTOR, { kind: 'system' as const }]) {
      for (const to of ['settling', 'cancelled', 'voided'] as const) {
        const error = await contestError(transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to, actor }));
        expect(error.code, `${actor.kind} -> ${to}`).toBe('operator_required');
        expect(error.apiType).toBe('permission_error');
      }
    }
    // The operator may, and cancelling an empty contest is allowed from there.
    const cancelled = await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'cancelled', actor: OPERATOR });
    expect(cancelled.after.state).toBe('cancelled');
  });

  it('under auto, the system or the tenant may leave awaiting_settlement', async () => {
    const contest = await makeContest(runtime.db, arena, { settlementPolicy: 'auto' });
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    const cancelled = await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'cancelled', actor: { kind: 'system' } });
    expect(cancelled.after.state).toBe('cancelled');
  });

  it('cancelled is only for a contest holding no entry; a contest with entrants must be voided', async () => {
    const contest = await openWithEntrants(runtime.db, arena);
    const error = await contestError(transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'cancelled', actor: OPERATOR }));
    expect(error.code).toBe('contest_has_entries');
    expect(error.detail).toMatchObject({ entries: 3 });
  });

  it('settled and voided cannot be reached with escrow still held, and settled needs results', async () => {
    const contest = await openWithEntrants(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'awaiting_settlement');
    const voided = await contestError(transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'voided', actor: OPERATOR }));
    expect(voided.code).toBe('escrow_not_empty');
    expect(voided.detail).toMatchObject({ balance: '300' });
    // `settling` is reachable, but `settled` then fails on the escrow guard inside the same transaction and nothing persists.
    const failure = await rejection(
      runtime.db.transaction(async (tx) => {
        await transition(tx, { tenantId: arena.tenantId, contestId: contest.id, to: 'settling', actor: OPERATOR });
        await transition(tx, { tenantId: arena.tenantId, contestId: contest.id, to: 'settled', actor: OPERATOR });
      }),
    );
    expect(failure).toMatchObject({ code: 'escrow_not_empty' });
    const [row] = await runtime.db.select().from(contests).where(eq(contests.id, contest.id));
    expect(row?.state).toBe('awaiting_settlement');
  });

  it('refuses another tenant’s contest and an unknown id', async () => {
    const contest = await makeContest(runtime.db, arena);
    const other = await buildArena(runtime.db, { users: 0 });
    const foreign = await contestError(transition(runtime.db, { tenantId: other.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR }));
    expect(foreign.code).toBe('contest_wrong_tenant');
    expect(foreign.apiType).toBe('permission_error');
    const missing = await contestError(transition(runtime.db, { tenantId: arena.tenantId, contestId: 'cnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9', to: 'open', actor: OPERATOR }));
    expect(missing.code).toBe('contest_not_found');
  });

  it('serialises under the row lock: of many simultaneous opens exactly one succeeds and the rest see the new state', async () => {
    const contest = await makeContest(runtime.db, arena);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR })),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'invalid_transition', detail: { from: 'open', to: 'open' } });
    }
    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id));
    expect(audit.map((row) => row.action).sort()).toEqual(['contest.created', 'contest.opened']);
  });

  it('holds the lock for the caller’s whole transaction, so a concurrent transition waits and then sees the result', async () => {
    const contest = await makeContest(runtime.db, arena);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = runtime.db.transaction(async (tx) => {
      await transition(tx, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR });
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR });
    const raced = await Promise.race([fast.then(() => 'done', () => 'done'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 200))]);
    expect(raced).toBe('waiting');
    release();
    await slow;
    await expect(fast).rejects.toMatchObject({ code: 'invalid_transition', detail: { from: 'open' } });
  });
});

describe('transitionContest() and updateContest()', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;

  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 4 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 2 });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('a plain transition is idempotent by key and refuses the settlement states', async () => {
    const contest = await makeContest(runtime.db, arena);
    const k = key('open');
    const first = await transitionContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR, idempotencyKey: k });
    expect(first).toMatchObject({ replayed: false, contest: { state: 'open' } });
    const again = await transitionContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR, idempotencyKey: k });
    expect(again).toMatchObject({ replayed: true, contest: { id: contest.id, state: 'open' } });
    const conflict = await contestError(transitionContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'locked', actor: OPERATOR, idempotencyKey: k }));
    expect(conflict.code).toBe('idempotency_conflict');
    const fresh = await contestError(transitionContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR, idempotencyKey: key() }));
    expect(fresh.code).toBe('invalid_transition');
    for (const to of ['settling', 'settled', 'voided'] as const) {
      const refused = await contestError(transitionContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to, actor: OPERATOR, idempotencyKey: key() }));
      expect(refused.code).toBe('invalid_input');
    }
    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, contest.id));
    expect(audit.filter((row) => row.action === 'contest.opened')).toHaveLength(1);
  });

  it('createContest opens the escrow account, validates the structure, is idempotent, and refuses a reused external_id', async () => {
    const k = key('create');
    const fields = { tenantId: arena.tenantId, externalId: 'sideout-evt-1', kind: 'tournament' as const, title: 'Doubles', asset: 'POINTS' as const, entryAmount: 250n, prizeStructure: { type: 'top_n_equal' as const, n: 2 } };
    const created = await createContest(runtime.db, { ...fields, idempotencyKey: k, actor: TENANT_ACTOR });
    expect(created.replayed).toBe(false);
    expect(created.contest).toMatchObject({ state: 'draft', tieBreak: 'split_evenly', settlementPolicy: 'operator_close', entryAmount: 250n, externalId: 'sideout-evt-1' });
    expect(created.escrowAccount).toMatchObject({ kind: 'contest_escrow', ownerRef: created.contest.id, asset: 'POINTS', id: created.contest.escrowAccountId });

    const replay = await createContest(runtime.db, { ...fields, idempotencyKey: k, actor: TENANT_ACTOR });
    expect(replay.replayed).toBe(true);
    expect(replay.contest.id).toBe(created.contest.id);
    expect(await runtime.db.select().from(contests)).toHaveLength(1);

    const reused = await contestError(createContest(runtime.db, { ...fields, idempotencyKey: key() }));
    expect(reused.code).toBe('external_id_taken');
    expect(reused.apiType).toBe('conflict');

    const badStructure = await contestError(createContest(runtime.db, { ...fields, externalId: 'x2', prizeStructure: { type: 'percentage_split', percentages: [60, 60] }, idempotencyKey: key() }));
    expect(badStructure.code).toBe('invalid_prize_structure');
    const badAmount = await contestError(createContest(runtime.db, { ...fields, externalId: 'x3', entryAmount: 0n, idempotencyKey: key() }));
    expect(badAmount.code).toBe('invalid_input');
    const badWindow = await contestError(createContest(runtime.db, { ...fields, externalId: 'x4', opensAt: new Date('2026-09-18T00:00:00Z'), locksAt: new Date('2026-09-17T00:00:00Z'), idempotencyKey: key() }));
    expect(badWindow.code).toBe('invalid_input');
    // An entry amount above the active ruleset's per-contest stake limit could never be entered.
    const unstakeable = await contestError(createContest(runtime.db, { ...fields, externalId: 'x5', entryAmount: 50_001n, idempotencyKey: key() }));
    expect(unstakeable.code).toBe('entry_amount_above_stake_limit');
    expect(unstakeable.apiType).toBe('invalid_request');
    expect(unstakeable.detail).toMatchObject({ field: 'entryAmount', entryAmount: '50001', perContest: 50_000, rulesetVersion: '2026.09.1' });
    expect(await runtime.db.select().from(contests)).toHaveLength(1);
    const atLimit = await createContest(runtime.db, { ...fields, externalId: 'x6', entryAmount: 50_000n, idempotencyKey: key() });
    expect(atLimit.contest.entryAmount).toBe(50_000n);
    const differentPayload = await contestError(createContest(runtime.db, { ...fields, title: 'Renamed', idempotencyKey: k }));
    expect(differentPayload.code).toBe('idempotency_conflict');
  });

  it('a draft edited above the stake limit cannot open until it is edited back', async () => {
    const contest = await makeContest(runtime.db, arena);
    await updateContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, patch: { entryAmount: 50_001n }, idempotencyKey: key(), actor: OPERATOR });
    const refused = await contestError(transitionContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR, idempotencyKey: key() }));
    expect(refused.code).toBe('entry_amount_above_stake_limit');
    expect(refused.detail).toMatchObject({ entryAmount: '50001', perContest: 50_000, rulesetVersion: '2026.09.1' });
    expect((await getContest(runtime.db, arena.tenantId, contest.id)).state).toBe('draft');
    await updateContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, patch: { entryAmount: 50_000n }, idempotencyKey: key(), actor: OPERATOR });
    const opened = await transitionContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR, idempotencyKey: key() });
    expect(opened.contest.state).toBe('open');
  });

  it('a draft can be edited; anything past draft is frozen by the service and by the database', async () => {
    const contest = await makeContest(runtime.db, arena);
    const edited = await updateContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, patch: { title: 'Renamed', entryAmount: 5n, maxParticipants: 8 }, idempotencyKey: key(), actor: OPERATOR });
    expect(edited.contest).toMatchObject({ title: 'Renamed', entryAmount: 5n, maxParticipants: 8, state: 'draft' });
    const empty = await contestError(updateContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, patch: {}, idempotencyKey: key(), actor: OPERATOR }));
    expect(empty.code).toBe('invalid_input');

    await transition(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, to: 'open', actor: OPERATOR });
    const frozen = await contestError(updateContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, patch: { title: 'Again' }, idempotencyKey: key(), actor: OPERATOR }));
    expect(frozen.code).toBe('invalid_contest_state');

    // The trigger refuses the owner too; locks_at may still move (an operator extending registration).
    const owner = await rejection(migrator.sql`update contests set entry_amount = 1 where id = ${contest.id}`);
    expect(String(owner)).toMatch(/is open, not draft; its defining fields are frozen/);
    expect((owner as { constraint_name?: string }).constraint_name).toBe('contests_frozen_after_draft');
    await expect(migrator.sql`update contests set locks_at = now() + interval '1 day' where id = ${contest.id}`).resolves.toBeDefined();
    const identity = await rejection(migrator.sql`update contests set asset = 'CREDIT' where id = ${contest.id}`);
    expect(String(identity)).toMatch(/identity fields cannot change|contests_escrow_account_id_asset_fk/);
  });
});

/** Exhaustive: the union of every state's targets covers each destination the spec names. */
it('every non-draft state is reachable', () => {
  const reachable = new Set<ContestState>(CONTEST_STATES.flatMap((from) => [...TRANSITIONS[from]]));
  expect([...reachable].sort()).toEqual(['awaiting_settlement', 'cancelled', 'in_progress', 'locked', 'open', 'settled', 'settling', 'voided']);
});
