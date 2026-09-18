import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AuditRowResource, RulesetResource, RulesetSummaryResource, RulesetTestInput, RulesetTestResource } from '@purse/types';

import { auditLog, eligibilityDecisions, rulesets } from '../../src/db/schema';
import { publishRuleset, SPEC_EXAMPLE_RULESET } from '../../src/eligibility';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { wipeLedger } from '../ledger/fixtures';
import { consoleClient } from './client';

/**
 * The ruleset editor and tester (spec 4.5, 4.10): the version history, one version's
 * JSON, a new version validated against the schema (admin), activation with an audit row
 * (admin), and "what would this decide": the pure evaluator over a sample user, persisting
 * nothing. The audit log is readable by subject.
 */
describe('console rulesets', () => {
  let h: TestHarness;
  let owner: ReturnType<typeof connectMigrator>;

  beforeAll(() => {
    owner = connectMigrator();
    h = harness();
  });
  beforeEach(async () => {
    await wipeLedger(owner);
    await publishRuleset(h.database.db, { body: SPEC_EXAMPLE_RULESET, activate: true });
  });
  afterAll(async () => {
    await wipeLedger(owner);
    await h.close();
    await owner.close();
  });

  it('lists versions and shows one with its body', async () => {
    const { api } = await consoleClient(h, owner.db, 'operator');
    const list = await api.get<{ rulesets: RulesetSummaryResource[] }>('/console/rulesets');
    expect(list.status).toBe(200);
    expect(list.data?.rulesets).toHaveLength(1);
    expect(list.data?.rulesets[0]).toMatchObject({ version: SPEC_EXAMPLE_RULESET.version, active: true });
    expect(list.data?.rulesets[0]).not.toHaveProperty('body');
    const one = await api.get<RulesetResource>(`/console/rulesets/${SPEC_EXAMPLE_RULESET.version}`);
    expect(one.data?.body).toEqual(SPEC_EXAMPLE_RULESET);
    expect((await api.get('/console/rulesets/2099.1.1')).status).toBe(404);
    expect((await api.get('/console/rulesets/not-a-version')).status).toBe(400);
  });

  it('publishes a new version from a valid body (admin only), refuses an invalid one with the issues, and a reused version with a different body', async () => {
    const operator = await consoleClient(h, owner.db, 'operator');
    const next = { ...SPEC_EXAMPLE_RULESET, version: '2026.10.1', stakeLimits: { perContest: 10_000, per24h: 50_000, per7d: 100_000 } };
    expect((await operator.api.post('/console/rulesets', { body: next }, { idempotencyKey: null })).status).toBe(403);

    const admin = await consoleClient(h, owner.db, 'admin');
    const invalid = await admin.api.post('/console/rulesets', { body: { ...next, minimumAge: { default: 'eighteen', byRegion: {} } } }, { idempotencyKey: null });
    expect(invalid.status).toBe(400);
    expect(invalid.error).toMatchObject({ type: 'invalid_request', code: 'invalid_ruleset' });
    const issues = invalid.error?.detail?.['issues'] as Array<{ path: string }>;
    expect(issues.map((issue) => issue.path)).toContain('minimumAge.default');

    const published = await admin.api.post<RulesetResource & { created: boolean }>('/console/rulesets', { body: next }, { idempotencyKey: null });
    expect(published.status).toBe(201);
    expect(published.data).toMatchObject({ version: '2026.10.1', active: false, created: true });
    // The same body again is the same version; a different body under it is refused.
    const again = await admin.api.post<RulesetResource & { created: boolean }>('/console/rulesets', { body: next }, { idempotencyKey: null });
    expect(again.status).toBe(200);
    expect(again.data?.created).toBe(false);
    const clash = await admin.api.post('/console/rulesets', { body: { ...next, minimumAge: { default: 21, byRegion: {} } } }, { idempotencyKey: null });
    expect(clash.status).toBe(409);
    expect(clash.error?.code).toBe('ruleset_version_taken');
    expect(await owner.db.select().from(rulesets)).toHaveLength(2);
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.action, 'ruleset.published'))).toHaveLength(2);
  });

  it('activates a version (admin only) with an audit row, exactly one active at a time', async () => {
    const admin = await consoleClient(h, owner.db, 'admin');
    const next = { ...SPEC_EXAMPLE_RULESET, version: '2026.10.2' };
    await admin.api.post('/console/rulesets', { body: next }, { idempotencyKey: null });
    const operator = await consoleClient(h, owner.db, 'operator');
    expect((await operator.api.post('/console/rulesets/2026.10.2/activate', {}, { idempotencyKey: null })).status).toBe(403);

    const activated = await admin.api.post<RulesetResource>('/console/rulesets/2026.10.2/activate', {}, { idempotencyKey: null });
    expect(activated.status).toBe(200);
    expect(activated.data?.active).toBe(true);
    const list = await admin.api.get<{ rulesets: RulesetSummaryResource[] }>('/console/rulesets');
    expect(list.data?.rulesets.filter((each) => each.active).map((each) => each.version)).toEqual(['2026.10.2']);
    expect((await admin.api.post('/console/rulesets/2099.1.1/activate', {}, { idempotencyKey: null })).status).toBe(404);
    // Activating the active version changes nothing and audits nothing more.
    await admin.api.post('/console/rulesets/2026.10.2/activate', {}, { idempotencyKey: null });
    const audit = await admin.api.get<{ audit: AuditRowResource[] }>('/console/audit?subject=ruleset:2026.10.2');
    expect(audit.data?.audit.map((row) => row.action)).toEqual(['ruleset.activated', 'ruleset.published']);
    expect(audit.data?.audit[0]).toMatchObject({ actorKind: 'operator', actorRef: admin.session.operator.id });
  });

  it('runs the tester against a sample user without persisting a decision', async () => {
    const { api } = await consoleClient(h, owner.db, 'operator');
    const sample: RulesetTestInput = {
      user: { dateOfBirth: '2010-01-01', verificationState: 'verified', restrictions: [], region: 'US-TX' },
      contest: { asset: 'CREDIT', entryAmount: '60000', kind: 'tournament' },
      wallet: { balance: '100' },
      velocity: { enteredLast24h: '0', enteredLast7d: '0' },
      asOf: '2026-09-18T12:00:00.000Z',
    };
    const refused = await api.post<RulesetTestResource>('/console/rulesets/evaluate', sample, { idempotencyKey: null });
    expect(refused.status).toBe(200);
    expect(refused.data).toMatchObject({ rulesetVersion: SPEC_EXAMPLE_RULESET.version, asOf: sample.asOf });
    expect(refused.data?.decision).toEqual({ allowed: false, rulesetVersion: SPEC_EXAMPLE_RULESET.version, reasons: ['under_minimum_age', 'stake_limit_exceeded', 'insufficient_balance'] });

    const allowed = await api.post<RulesetTestResource>('/console/rulesets/evaluate', { ...sample, user: { ...sample.user, dateOfBirth: '1990-01-01' }, contest: { ...sample.contest, entryAmount: '50' } }, { idempotencyKey: null });
    expect(allowed.data?.decision).toEqual({ allowed: true, rulesetVersion: SPEC_EXAMPLE_RULESET.version });

    // A specific version, a restriction in force, and money as strings.
    const blocked = await api.post<RulesetTestResource>(
      '/console/rulesets/evaluate',
      { ...sample, rulesetVersion: SPEC_EXAMPLE_RULESET.version, user: { ...sample.user, dateOfBirth: '1990-01-01', restrictions: [{ kind: 'platform_block', startsAt: '2026-09-01T00:00:00.000Z', endsAt: null }] } },
      { idempotencyKey: null },
    );
    expect(blocked.data?.decision.allowed).toBe(false);
    expect(blocked.data?.decision.allowed === false ? blocked.data.decision.reasons : []).toContain('platform_blocked');
    expect((await api.post('/console/rulesets/evaluate', { ...sample, rulesetVersion: '2099.1.1' }, { idempotencyKey: null })).status).toBe(404);
    expect((await api.post('/console/rulesets/evaluate', { ...sample, wallet: { balance: 1.5 } }, { idempotencyKey: null })).status).toBe(400);
    expect(await owner.db.select().from(eligibilityDecisions)).toEqual([]);
  });
});
