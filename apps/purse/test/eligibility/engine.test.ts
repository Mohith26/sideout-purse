import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '@repo/ids';

import { closeContest, enterContest, previewSettlement, withdrawEntry } from '../../src/contests';
import type { Database } from '../../src/db/client';
import { contests, eligibilityDecisions, operatorFlags, rulesets } from '../../src/db/schema';
import {
  activateRuleset,
  activeRuleset,
  collusionPairs,
  entryVelocity,
  flagCollusion,
  parseRuleset,
  publishRuleset,
  RulesetError,
  rulesetForContest,
  rulesetSchema,
  SPEC_EXAMPLE_RULESET,
} from '../../src/eligibility';
import { devRiskProvider } from '../../src/providers';
import { addRestriction, refreshFingerprint, getUser, locationOf } from '../../src/users';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { createUser, key, wipeLedger } from '../ledger/fixtures';
import { advance, buildArena, contestError, eligibleUser, fund, inProgress, makeContest, OPERATOR, score, TENANT_ACTOR, type Arena } from '../contests/fixtures';

/**
 * The impure half of spec 4.5 and the risk controls of 4.6: stored, versioned rulesets;
 * velocity computed from the journal; every entry attempt leaving a decision record with
 * its ruleset version; restrictions honoured at entry; the risk seam's signals and the
 * head-to-head collusion signal surfacing as operator flags and nothing more.
 */
describe('stored rulesets', () => {
  let migrator: Database;
  let runtime: Database;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('validates the spec shape and refuses anything else', () => {
    expect(rulesetSchema.parse(SPEC_EXAMPLE_RULESET)).toEqual(SPEC_EXAMPLE_RULESET);
    // The spec's example JSON, without phase 3's `collusion`, validates and gets the defaults.
    const { collusion: _omitted, ...spec } = SPEC_EXAMPLE_RULESET;
    expect(parseRuleset(spec).collusion).toEqual({ minMeetings: 5, oneSidedShare: 0.8 });
    for (const [name, body] of [
      ['a bad version', { ...spec, version: 'v1' }],
      ['an unknown field', { ...spec, extra: true }],
      ['a region that is not a code', { ...spec, permittedRegions: { POINTS: 'ALL', CREDIT: ['texas'] } }],
      ['a negative limit', { ...spec, stakeLimits: { perContest: -1, per24h: null, per7d: null } }],
      ['a fractional limit', { ...spec, stakeLimits: { perContest: 1.5, per24h: null, per7d: null } }],
      ['a missing asset', { ...spec, requireKnownRegion: { POINTS: false } }],
      ['an impossible age', { ...spec, minimumAge: { default: 200, byRegion: {} } }],
    ] as const) {
      expect(() => parseRuleset(body), name).toThrow(RulesetError);
    }
  });

  it('stores a version once, keeps exactly one active, and never changes a stored body', async () => {
    const first = await publishRuleset(runtime.db, { body: SPEC_EXAMPLE_RULESET, activate: true });
    expect(first.created).toBe(true);
    expect(first.ruleset.active).toBe(true);
    expect((await activeRuleset(runtime.db))?.version).toBe('2026.09.1');

    // The same body again is found, not duplicated; a different body under the version is refused.
    const again = await publishRuleset(runtime.db, { body: SPEC_EXAMPLE_RULESET });
    expect(again.created).toBe(false);
    const clash = await rejection(publishRuleset(runtime.db, { body: { ...SPEC_EXAMPLE_RULESET, minimumAge: { default: 21, byRegion: {} } } }));
    expect(clash).toBeInstanceOf(RulesetError);

    const next = { ...SPEC_EXAMPLE_RULESET, version: '2026.10.1', stakeLimits: { perContest: 10, per24h: 20, per7d: 30 } };
    const second = await publishRuleset(runtime.db, { body: next });
    expect(second.ruleset.active).toBe(false);
    await activateRuleset(runtime.db, { version: '2026.10.1' });
    const rows = await runtime.db.select().from(rulesets);
    expect(rows.map((row) => [row.version, row.active]).sort()).toEqual([
      ['2026.09.1', false],
      ['2026.10.1', true],
    ]);
    expect((await activeRuleset(runtime.db))?.stakeLimits.perContest).toBe(10);

    // Two active at once is impossible, and a body is immutable, for every role.
    const twoActive = await rejection(migrator.db.update(rulesets).set({ active: true }).where(eq(rulesets.version, '2026.09.1')));
    expect(String((twoActive as Error).cause)).toMatch(/rulesets_one_active_key/);
    const edit = await rejection(migrator.db.update(rulesets).set({ body: next }).where(eq(rulesets.version, '2026.09.1')));
    expect(String((edit as Error).cause)).toMatch(/fixed once written/);
    const runtimeEdit = await rejection(runtime.sql`update rulesets set body = '{}' where version = '2026.09.1'`);
    expect(String(runtimeEdit)).toMatch(/permission denied for table rulesets/);
    expect(await rejection(activateRuleset(runtime.db, { version: '1999.1.1' }))).toBeInstanceOf(RulesetError);
  });

  it('pins the active version on a contest at creation and judges its entries under it', async () => {
    const arena = await buildArena(runtime.db, { users: 1 });
    const pinned = await makeContest(runtime.db, arena);
    expect(pinned.eligibilityRulesetVersion).toBe('2026.09.1');
    await publishRuleset(runtime.db, { body: { ...SPEC_EXAMPLE_RULESET, version: '2026.10.1', stakeLimits: { perContest: 100, per24h: 50, per7d: 50 } }, activate: true });
    const later = await makeContest(runtime.db, arena);
    expect(later.eligibilityRulesetVersion).toBe('2026.10.1');
    expect((await rulesetForContest(runtime.db, pinned)).version).toBe('2026.09.1');
    expect((await rulesetForContest(runtime.db, later)).version).toBe('2026.10.1');
    // A contest from before any ruleset existed falls back to the active one.
    expect((await rulesetForContest(runtime.db, { eligibilityRulesetVersion: null })).version).toBe('2026.10.1');

    // The old contest still admits a 100-unit entry; under the new pin the same entry is over the 50-unit velocity limit.
    await advance(runtime.db, arena, pinned.id, 'open');
    await advance(runtime.db, arena, later.id, 'open');
    const user = arena.users[0] ?? ('' as Id<'usr'>);
    await expect(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: pinned.id, userId: user, idempotencyKey: key() })).resolves.toMatchObject({ eligibility: { allowed: true, rulesetVersion: '2026.09.1' } });
    const refused = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: later.id, userId: user, idempotencyKey: key() }));
    expect(refused.detail).toMatchObject({ reasons: ['velocity_limit_exceeded'], rulesetVersion: '2026.10.1' });
    const [row] = await runtime.db.select().from(contests).where(eq(contests.id, later.id));
    expect(row?.eligibilityRulesetVersion).toBe('2026.10.1');
  });
});

describe('entry decisions (spec 4.5, 4.6)', () => {
  let migrator: Database;
  let runtime: Database;
  let arena: Arena;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime({ max: 8 });
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    arena = await buildArena(runtime.db, { users: 3, funding: 10_000n });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const user = (i: number) => arena.users[i] ?? ('' as Id<'usr'>);

  it('computes velocity from the journal: rolling 24h and 7d gross stakes in the asset, withdrawals included', async () => {
    const a = await makeContest(runtime.db, arena, { entryAmount: 300n });
    const b = await makeContest(runtime.db, arena, { entryAmount: 500n });
    await advance(runtime.db, arena, a.id, 'open');
    await advance(runtime.db, arena, b.id, 'open');
    const now = new Date();
    expect(await entryVelocity(runtime.db, { tenantId: arena.tenantId, userId: user(0), asset: 'POINTS', now })).toEqual({ enteredLast24h: 0n, enteredLast7d: 0n });
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: a.id, userId: user(0), idempotencyKey: key() });
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: b.id, userId: user(0), idempotencyKey: key() });
    await withdrawEntry(runtime.db, { tenantId: arena.tenantId, contestId: b.id, userId: user(0), idempotencyKey: key() });
    const after = await entryVelocity(runtime.db, { tenantId: arena.tenantId, userId: user(0), asset: 'POINTS', now: new Date() });
    expect(after).toEqual({ enteredLast24h: 800n, enteredLast7d: 800n });
    // Another asset and another user see nothing of it; the windows are bounded on posted_at.
    expect(await entryVelocity(runtime.db, { tenantId: arena.tenantId, userId: user(0), asset: 'CREDIT', now: new Date() })).toEqual({ enteredLast24h: 0n, enteredLast7d: 0n });
    expect(await entryVelocity(runtime.db, { tenantId: arena.tenantId, userId: user(1), asset: 'POINTS', now: new Date() })).toEqual({ enteredLast24h: 0n, enteredLast7d: 0n });
    const tomorrow = new Date(Date.now() + 25 * 3_600_000);
    expect(await entryVelocity(runtime.db, { tenantId: arena.tenantId, userId: user(0), asset: 'POINTS', now: tomorrow })).toEqual({ enteredLast24h: 0n, enteredLast7d: 800n });
    const nextWeek = new Date(Date.now() + 8 * 24 * 3_600_000);
    expect(await entryVelocity(runtime.db, { tenantId: arena.tenantId, userId: user(0), asset: 'POINTS', now: nextWeek })).toEqual({ enteredLast24h: 0n, enteredLast7d: 0n });
  });

  it('enforces the rolling limits at entry, from the journal, under the contest lock', async () => {
    await publishRuleset(runtime.db, { body: { ...SPEC_EXAMPLE_RULESET, version: '2026.10.1', stakeLimits: { perContest: 1_000, per24h: 250, per7d: 1_000 } }, activate: true });
    const a = await makeContest(runtime.db, arena, { entryAmount: 100n });
    const b = await makeContest(runtime.db, arena, { entryAmount: 100n });
    const c = await makeContest(runtime.db, arena, { entryAmount: 100n });
    for (const contest of [a, b, c]) await advance(runtime.db, arena, contest.id, 'open');
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: a.id, userId: user(0), idempotencyKey: key() });
    await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: b.id, userId: user(0), idempotencyKey: key() });
    const third = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: c.id, userId: user(0), idempotencyKey: key() }));
    expect(third.code).toBe('not_eligible');
    expect(third.detail).toMatchObject({ reasons: ['velocity_limit_exceeded'], rulesetVersion: '2026.10.1' });
    expect(third.detail['requiredAction']).toBeUndefined();
    // Recorded, with the velocity the decision saw.
    const [refusal] = await runtime.db.select().from(eligibilityDecisions).where(eq(eligibilityDecisions.contestId, c.id));
    expect(refusal).toMatchObject({ allowed: false, reasons: ['velocity_limit_exceeded'], rulesetVersion: '2026.10.1', userId: user(0) });
    expect(refusal?.context).toMatchObject({ velocity: { enteredLast24h: '200', enteredLast7d: '200' }, entryAmount: '100', asset: 'POINTS' });
    // Another user is unaffected.
    await expect(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: c.id, userId: user(1), idempotencyKey: key() })).resolves.toMatchObject({ eligibility: { allowed: true } });
  });

  it('honours self-exclusion and cool-off before every entry and records the refusal, moving nothing', async () => {
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    await addRestriction(runtime.db, { tenantId: arena.tenantId, userId: user(0), kind: 'self_exclusion', actor: { kind: 'user', ref: user(0) }, reason: 'taking a break' });
    await addRestriction(runtime.db, { tenantId: arena.tenantId, userId: user(1), kind: 'cool_off', endsAt: new Date(Date.now() + 3_600_000), actor: { kind: 'user', ref: user(1) } });
    const excluded = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(0), idempotencyKey: key(), requestId: 'req-se' }));
    expect(excluded.detail).toMatchObject({ reasons: ['self_excluded'] });
    const cooling = await contestError(enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: user(1), idempotencyKey: key() }));
    expect(cooling.detail).toMatchObject({ reasons: ['cooling_off'] });
    const decisions = await runtime.db.select().from(eligibilityDecisions).where(eq(eligibilityDecisions.contestId, contest.id));
    expect(decisions.map((row) => [row.userId, row.reasons, row.requestId])).toEqual([
      [user(0), ['self_excluded'], 'req-se'],
      [user(1), ['cooling_off'], null],
    ]);
    expect(decisions[0]?.context).toMatchObject({ restrictions: [{ kind: 'self_exclusion', endsAt: null }] });
    // Nothing else happened: no participant, no escrow, no wallet debit.
    const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
    expect(preview.entries).toEqual([]);
    expect(preview.escrowTotal).toBe(0n);
  });

  it('CREDIT is verification- and region-gated at entry, POINTS is not', async () => {
    const credit = await buildArena(runtime.db, { users: 0, asset: 'CREDIT' });
    const unverified = await createUser(runtime.db, credit.tenantId, { dateOfBirth: null });
    await fund(runtime.db, credit, unverified.id as Id<'usr'>, 1_000n);
    const contest = await makeContest(runtime.db, credit, { asset: 'CREDIT', entryAmount: 100n });
    await advance(runtime.db, credit, contest.id, 'open');
    const refused = await contestError(enterContest(runtime.db, { tenantId: credit.tenantId, contestId: contest.id, userId: unverified.id, idempotencyKey: key() }));
    expect(refused.detail).toMatchObject({ reasons: ['region_unknown', 'identity_unverified'], requiredAction: 'confirm_location' });
    // With a region declared through the geo seam and still no identity, the next action is demographics.
    const { devGeoProvider } = await import('../../src/providers');
    const located = await contestError(enterContest(runtime.db, { tenantId: credit.tenantId, contestId: contest.id, userId: unverified.id, idempotencyKey: key(), location: { declaredRegion: 'US-TX' }, providers: { geo: devGeoProvider() } }));
    expect(located.detail).toMatchObject({ reasons: ['identity_unverified'], requiredAction: 'provide_demographics' });
    // The location is a fact about the user and outlives the refusal: the next attempt need not repeat it.
    await expect(locationOf(runtime.db, unverified.id)).resolves.toMatchObject({ regionCode: 'US-TX', source: 'declared' });
    const remembered = await contestError(enterContest(runtime.db, { tenantId: credit.tenantId, contestId: contest.id, userId: unverified.id, idempotencyKey: key() }));
    expect(remembered.detail).toMatchObject({ reasons: ['identity_unverified'] });
    // The same user enters a POINTS contest with no questions asked.
    const promo = await buildArena(runtime.db, { users: 0 });
    const points = await createUser(runtime.db, promo.tenantId, { dateOfBirth: null });
    await fund(runtime.db, promo, points.id as Id<'usr'>, 1_000n);
    const free = await makeContest(runtime.db, promo, { entryAmount: 100n });
    await advance(runtime.db, promo, free.id, 'open');
    await expect(enterContest(runtime.db, { tenantId: promo.tenantId, contestId: free.id, userId: points.id, idempotencyKey: key() })).resolves.toMatchObject({ eligibility: { allowed: true } });
  });

  it('surfaces the risk seam as an operator flag, never as a block', async () => {
    // Two users sharing a name and date of birth: a duplicate-identity flag for the pair.
    const twin = await createUser(runtime.db, arena.tenantId, { displayName: 'Same Person', dateOfBirth: '1990-06-01' });
    const other = await createUser(runtime.db, arena.tenantId, { displayName: 'same  PERSON', dateOfBirth: '1990-06-01' });
    await refreshFingerprint(runtime.db, twin);
    const { flags } = await refreshFingerprint(runtime.db, other);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'duplicate_identity', status: 'open' });

    const twinId = await eligibleUser(runtime.db, arena.tenantId, twin.id as Id<'usr'>);
    await fund(runtime.db, arena, twinId, 1_000n);
    const contest = await makeContest(runtime.db, arena);
    await advance(runtime.db, arena, contest.id, 'open');
    const entered = await enterContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, userId: twinId, idempotencyKey: key(), providers: { risk: devRiskProvider() } });
    expect(entered.eligibility.allowed).toBe(true);
    expect(entered.decision.context).toMatchObject({ risk: { provider: 'dev', decision: 'review', signals: [{ code: 'duplicate_identity_open' }] } });
    const review = await runtime.db.select().from(operatorFlags).where(eq(operatorFlags.kind, 'risk_review'));
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ subject: twinId, dedupeKey: `user:${twinId}:contest:${contest.id}`, status: 'open' });
    expect(review[0]?.detail).toMatchObject({ decision: 'review', signals: [{ code: 'duplicate_identity_open' }] });
  });

  it('flags the head-to-head collusion signal after enough one-sided meetings, and only surfaces it', async () => {
    const [a, b, c] = [user(0), user(1), user(2)];
    const meet = async (winner: Id<'usr'>, loser: Id<'usr'>) => {
      const contest = await inProgress(runtime.db, arena, { kind: 'head_to_head', prizeStructure: { type: 'winner_take_all' } }, [winner, loser]);
      await score(runtime.db, arena, contest.id, [10, 5], { users: [winner, loser] });
      const preview = await previewSettlement(runtime.db, { tenantId: arena.tenantId, contestId: contest.id });
      await closeContest(runtime.db, { tenantId: arena.tenantId, contestId: contest.id, payoutHash: preview.payoutHash, actor: OPERATOR, idempotencyKey: key() });
    };
    // a beats b four times: a meeting short of the threshold.
    for (let i = 0; i < 4; i += 1) await meet(a, b);
    expect(await collusionPairs(runtime.db, { tenantId: arena.tenantId, ruleset: SPEC_EXAMPLE_RULESET, users: [a, b] })).toEqual([]);
    expect(await runtime.db.select().from(operatorFlags).where(eq(operatorFlags.kind, 'collusion_signal'))).toEqual([]);
    // The fifth meeting tips it, inside the settlement that recorded it.
    await meet(a, b);
    const [pair] = [a, b].sort();
    const flagged = await runtime.db.select().from(operatorFlags).where(eq(operatorFlags.kind, 'collusion_signal'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ subject: pair, dedupeKey: `pair:${[a, b].sort().join(':')}`, status: 'open' });
    expect(flagged[0]?.detail).toMatchObject({ meetings: 5, share: 1, rulesetVersion: '2026.09.1' });
    // A balanced rivalry is not a signal: c and b trade wins.
    for (let i = 0; i < 3; i += 1) {
      await meet(c, b);
      await meet(b, c);
    }
    const pairs = await collusionPairs(runtime.db, { tenantId: arena.tenantId, ruleset: SPEC_EXAMPLE_RULESET, users: [a, b, c] });
    expect(pairs.map((each) => [each.a, each.b, each.meetings, each.share])).toEqual([[...[a, b].sort(), 5, 1]]);
    expect(await collusionPairs(runtime.db, { tenantId: arena.tenantId, ruleset: SPEC_EXAMPLE_RULESET, users: [] })).toEqual([]);
    // Flagging the pair again raises nothing new; nothing was blocked.
    const again = await flagCollusion(runtime.db, { tenantId: arena.tenantId, ruleset: SPEC_EXAMPLE_RULESET, users: [a, b] });
    expect(again.flags).toEqual([]);
    expect(await runtime.db.select().from(operatorFlags).where(eq(operatorFlags.kind, 'collusion_signal'))).toHaveLength(1);
    const rematch = await inProgress(runtime.db, arena, { kind: 'head_to_head' }, [a, b]);
    expect(rematch.state).toBe('in_progress');
    await expect(getUser(runtime.db, arena.tenantId, a)).resolves.toMatchObject({ id: a });
    expect(TENANT_ACTOR.kind).toBe('tenant');
  });
});
